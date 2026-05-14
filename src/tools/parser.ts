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
  private TOOL_START = '<tool_call>';
  private TOOL_END = '</tool_call>';
  private emittedToolCallCount = 0;

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
        const startIdx = this.buffer.indexOf(this.TOOL_START);
        if (startIdx !== -1) {
          // Found tool start. Everything before it is text (if no tools emitted yet)
          const textToEmit = this.buffer.substring(0, startIdx);
          if (textToEmit && this.emittedToolCallCount === 0) {
            result.text += textToEmit;
          }
          this.insideTool = true;
          this.buffer = this.buffer.substring(startIdx + this.TOOL_START.length);
        } else {
          // No full start tag. Check for partial match at the end to avoid emitting half a tag
          let flushIndex = this.buffer.length;
          for (let i = 1; i <= this.TOOL_START.length; i++) {
            if (this.buffer.endsWith(this.TOOL_START.substring(0, i))) {
              flushIndex = this.buffer.length - i;
              break;
            }
          }
          
          const textToEmit = this.buffer.substring(0, flushIndex);
          if (textToEmit && this.emittedToolCallCount === 0) {
            result.text += textToEmit;
          }
          this.buffer = this.buffer.substring(flushIndex);
          break; // Wait for more data
        }
      } else {
        // Inside tool
        const endIdx = this.buffer.indexOf(this.TOOL_END);
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
          this.buffer = this.buffer.substring(endIdx + this.TOOL_END.length);
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
            result.text = this.TOOL_START + this.buffer;
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
