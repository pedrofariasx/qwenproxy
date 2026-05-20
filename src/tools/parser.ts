/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

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
    // Qwen tends to reproduce XML-looking tags as user-visible prose. The
    // prompt therefore uses rare Bengali/sparkle delimiters; parse them into
    // structured OpenAI tool_calls instead of streaming them as content.
    { start: 'তত', end: '✨' },
    // Be tolerant when the model drops one repeated Bengali character.
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
          // Found tool start. Everything before it is text (if no tools emitted yet)
          const textToEmit = this.buffer.substring(0, startMatch.index);
          if (textToEmit && this.emittedToolCallCount === 0) {
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
          if (textToEmit && this.emittedToolCallCount === 0) {
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
          try {
            const toolCallObj = robustParseJSON(toolJsonStr);
            if (toolCallObj) {
              const toolId = 'call_' + uuidv4();
              let toolName = toolCallObj.name || '';
              let toolArgs: Record<string, unknown> = {};

              if (toolCallObj.arguments) {
                toolArgs = typeof toolCallObj.arguments === 'string'
                  ? JSON.parse(toolCallObj.arguments)
                  : toolCallObj.arguments;
              } else {
                const { name, ...rest } = toolCallObj;
                toolArgs = rest;
              }

              result.toolCalls.push({
                id: toolId,
                name: toolName,
                arguments: toolArgs,
              });
              this.emittedToolCallCount++;
            }
          } catch (e) {
            console.warn(`[StreamingToolParser] Parsing failed for: ${toolJsonStr}`, e);
            // If it fails, we treat it as text if no tools were emitted yet, 
            // but this is tricky in a streaming context. 
            // For now, we just log and move on.
          }
          
          this.insideTool = false;
          const activeEndLength = this.activeToolEnd.length;
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
          if (toolCallObj) {
            const toolId = 'call_' + uuidv4();
            let toolName = toolCallObj.name || '';
            let toolArgs = toolCallObj.arguments || {};
            if (typeof toolArgs === 'string') toolArgs = JSON.parse(toolArgs);
            else if (!toolCallObj.arguments) {
               const { name, ...rest } = toolCallObj;
               toolArgs = rest;
            }

            result.toolCalls.push({
              id: toolId,
              name: toolName,
              arguments: toolArgs,
            });
            this.emittedToolCallCount++;
          }
        } catch (e) {
          if (this.emittedToolCallCount === 0) {
            result.text = this.activeToolStart + this.buffer;
          }
        }
      } else if (this.emittedToolCallCount === 0) {
        result.text = this.buffer;
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
