/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

function fixArrayJson(str: string): string | null {
  // Try to extract individual tool calls from a malformed array
  const results: string[] = [];
  let depth = 0;
  let current = '';
  
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '{') {
      depth++;
      if (depth === 1) current = '{';
      else current += c;
    } else if (c === '}') {
      depth--;
      current += c;
      if (depth === 0 && current.trim()) {
        results.push(current.trim());
        current = '';
      }
    } else if (depth > 0) {
      current += c;
    }
  }
  
  if (results.length > 0) {
    return '[' + results.join(',') + ']';
  }
  return null;
}

export interface ParserResult {
  /** Text content that is NOT part of a tool call */
  text: string;
  /** Fully parsed tool calls */
  toolCalls: ParsedToolCall[];
}

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private readonly TOOL_SYNTAXES = [
    { start: '<tool_call>', end: '</tool_call>' },
    { start: 'তত', end: '✨' },
    { start: 'ত', end: '✨' },
  ];
  private activeToolStart = '<tool_call>';
  private activeToolEnd = '</tool_call>';
  private emittedToolCallCount = 0;

  private findNextStart(): { index: number; start: string; end: string } | null {
    let best: { index: number; start: string; end: string } | null = null;
    for (const syntax of this.TOOL_SYNTAXES) {
      const index = this.buffer.indexOf(syntax.start);
      if (index === -1) continue;
      if (!best || index < best.index || (index === best.index && syntax.start.length > best.start.length)) {
        best = { index, start: syntax.start, end: syntax.end };
      }
    }
    return best;
  }

  private partialStartLengthAtBufferEnd(): number {
    let longest = 0;
    for (const syntax of this.TOOL_SYNTAXES) {
      for (let i = 1; i < syntax.start.length; i++) {
        if (this.buffer.endsWith(syntax.start.substring(0, i))) {
          longest = Math.max(longest, i);
        }
      }
    }
    return longest;
  }

  /**
   * Feeds a chunk of text into the parser and returns any extracted text and tool calls.
   */
  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = {
      text: '',
      toolCalls: [],
    };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const startMatch = this.findNextStart();
        if (startMatch) {
          // Found tool start. Everything before it is text
          const textToEmit = this.buffer.substring(0, startMatch.index);
          if (textToEmit) {
            result.text += textToEmit;
          }
          this.insideTool = true;
          this.activeToolStart = startMatch.start;
          this.activeToolEnd = startMatch.end;
          this.buffer = this.buffer.substring(startMatch.index + startMatch.start.length);
        } else {
          // No full start tag. Check for partial match at the end to avoid emitting half a tag
          const partialLength = this.partialStartLengthAtBufferEnd();
          const flushIndex = this.buffer.length - partialLength;
          
          const textToEmit = this.buffer.substring(0, flushIndex);
          if (textToEmit) {
            result.text += textToEmit;
          }
          this.buffer = this.buffer.substring(flushIndex);
          break; // Wait for more data
        }
      } else {
        // Inside tool
        const endIdx = this.buffer.indexOf(this.activeToolEnd);
        if (endIdx !== -1) {
          const toolJsonStr = this.buffer.substring(0, endIdx).trim();
          const originalStart = this.activeToolStart;
          const originalEnd = this.activeToolEnd;
          
          try {
            const content = toolJsonStr.trim();
            let parsedCalls: any[] = [];

            // Try parsing as array of tool calls first
            if (content.startsWith('[')) {
              try {
                parsedCalls = JSON.parse(content);
              } catch {
                // Try to fix array issues
                const fixed = fixArrayJson(content);
                if (fixed) parsedCalls = JSON.parse(fixed);
              }
            } else {
              // Try single tool call
              const single = robustParseJSON(content);
              if (single) parsedCalls = [single];
            }

            for (const parsed of parsedCalls) {
              if (parsed && typeof parsed === 'object' && (parsed.name || parsed.function)) {
                result.toolCalls.push({
                  id: `call_${uuidv4()}`,
                  name: parsed.name || parsed.function?.name || 'unknown',
                  arguments: typeof parsed.arguments === 'string' 
                    ? JSON.parse(parsed.arguments)
                    : (parsed.arguments || parsed.function?.arguments || {})
                });
                this.emittedToolCallCount++;
              } else {
                result.text += originalStart + content + originalEnd;
              }
            }

            if (parsedCalls.length === 0) {
              result.text += originalStart + content + originalEnd;
            }
          } catch (e) {
            console.warn(`[StreamingToolParser] Parsing failed for: ${toolJsonStr}`, e);
            result.text += originalStart + toolJsonStr + originalEnd;
          }
          
          this.insideTool = false;
          const activeEndLength = originalEnd.length;
          this.activeToolStart = '<tool_call>';
          this.activeToolEnd = '</tool_call>';
          this.buffer = this.buffer.substring(endIdx + activeEndLength);
        } else {
          // Waiting for TOOL_END, buffer the content
          break;
        }
      }
    }

    return result;
  }

  /**
   * Finalizes the parsing, attempting to extract any remaining content.
   */
  flush(): ParserResult {
    const result: ParserResult = {
      text: '',
      toolCalls: [],
    };

    if (this.buffer.length > 0) {
      if (this.insideTool) {
        // Try to parse partial tool call
        try {
          const toolCallObj = robustParseJSON(this.buffer);
          if (toolCallObj && typeof toolCallObj === 'object' && (toolCallObj.name || toolCallObj.function)) {
            result.toolCalls.push({
              id: `call_${uuidv4()}`,
              name: toolCallObj.name || toolCallObj.function?.name || 'unknown',
              arguments: typeof toolCallObj.arguments === 'string' 
                ? JSON.parse(toolCallObj.arguments)
                : (toolCallObj.arguments || toolCallObj.function?.arguments || {})
            });
            this.emittedToolCallCount++;
          } else {
            result.text += this.activeToolStart + this.buffer;
          }
        } catch (e) {
          result.text += this.activeToolStart + this.buffer;
        }
      } else {
        result.text += this.buffer;
      }
    }

    this.buffer = '';
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }
}
