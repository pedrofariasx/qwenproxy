/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 */

import { randomUUID } from 'crypto';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from '../utils/types.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

import { TOOL_CALL_START, TOOL_CALL_END } from '../constants.ts';

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private readonly TOOL_START = TOOL_CALL_START;
  private readonly TOOL_END = TOOL_CALL_END;
  private emittedToolCallCount = 0;

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          const textBefore = this.buffer.substring(0, startIdx);
          if (textBefore.trim()) {
            result.text += textBefore;
          }
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
          this.insideTool = true;
        } else {
          const partialLength = this.getPartialMatchLength(this.TOOL_START);
          const flushIndex = this.buffer.length - partialLength;
          if (flushIndex > 0) {
            result.text += this.buffer.substring(0, flushIndex);
            this.buffer = this.buffer.substring(flushIndex);
          }
          break;
        }
} else {
          // Check for nested opening tag (model forgot closing tag before next tool call)
          const nestedStart = this.buffer.indexOf(this.TOOL_START);
          const endIdx = this.findTagOutsideQuotes(this.TOOL_END);

          if (nestedStart !== -1 && (endIdx === -1 || nestedStart < endIdx)) {
            // Another <tool_call > found before </tool_call > — split here
            const content = this.buffer.substring(0, nestedStart);
            this.processToolContent(content, result);
            this.buffer = this.buffer.substring(nestedStart + this.TOOL_START.length);
            // Stay insideTool for the next tool call
          } else if (endIdx !== -1) {
            const content = this.buffer.substring(0, endIdx);
            this.buffer = this.buffer.substring(endIdx + this.TOOL_END.length);
            this.processToolContent(content, result);
            this.insideTool = false;
          } else {
            break;
          }
        }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (!this.buffer) return result;

    if (this.insideTool) {
      this.processToolContent(this.buffer, result);
    } else {
      result.text += this.buffer;
    }

    this.buffer = '';
    this.insideTool = false;
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  private processToolContent(content: string, result: ParserResult): void {
    const t = content.trim();
    if (!t) return;

    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
      } catch {
        result.text += this.TOOL_START + content + this.TOOL_END;
      }
    } else if (t.startsWith('{')) {
      const tc = this.parseToolContent(t);
      if (tc) {
        result.toolCalls.push(tc);
        this.emittedToolCallCount++;
      } else {
        result.text += this.TOOL_START + content + this.TOOL_END;
      }
    } else {
      result.text += this.TOOL_START + content + this.TOOL_END;
    }
  }

  private parseToolContent(str: string): ParsedToolCall | null {
    try {
      const parsed = robustParseJSON(str);
      if (!parsed || typeof parsed !== 'object') return null;
      return this.parseToolCall(parsed);
    } catch {
      return null;
    }
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== 'object') return null;

    const name = parsed.name || parsed.function?.name;
    if (!name || typeof name !== 'string') return null;

    let args = parsed.arguments || parsed.function?.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return {
      id: `call_${randomUUID()}`,
      name,
      arguments: args,
    };
  }

  private getPartialMatchLength(tag: string): number {
    let maxMatch = 0;
    for (let i = 1; i <= tag.length; i++) {
      if (this.buffer.endsWith(tag.substring(0, i))) {
        maxMatch = i;
      }
    }
    return maxMatch;
  }

  isEndTagFragment(): boolean {
    if (this.findTagOutsideQuotes(this.TOOL_END) !== -1) return false;
    return this.getPartialMatchLengthOutsideQuotes(this.TOOL_END) > 0;
  }

  private findTagOutsideQuotes(tag: string): number {
    let searchStart = 0;
    while (true) {
      const idx = this.buffer.indexOf(tag, searchStart);
      if (idx === -1) return -1;
      if (this.isOutsideQuotes(idx)) {
        return idx;
      }
      searchStart = idx + 1;
    }
  }

  private isOutsideQuotes(upToPosition: number): boolean {
    let inString = false;
    for (let i = 0; i < upToPosition; i++) {
      const ch = this.buffer[i];
      if (inString && ch === '\\' && i + 1 < upToPosition) {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
      }
    }
    return !inString;
  }

  private getPartialMatchLengthOutsideQuotes(tag: string): number {
    let maxMatch = 0;
    for (let i = 1; i <= tag.length; i++) {
      if (this.buffer.endsWith(tag.substring(0, i))) {
        const startPos = this.buffer.length - i;
        if (this.isOutsideQuotes(startPos)) {
          maxMatch = i;
        }
      }
    }
    return maxMatch;
  }
}