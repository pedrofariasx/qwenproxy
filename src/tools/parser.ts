/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

type ParsedToolPayload = {
  name?: string;
  arguments?: Record<string, unknown> | string;
} & Record<string, unknown>;

export interface InvalidToolCall {
  raw: string;
  reason: 'parse_failed' | 'invalid_payload';
}

export interface StreamingToolParserOptions {
  fallbackInvalidToolCallsToText?: boolean;
}

export interface ParserResult {
  /** Text content that is NOT part of a tool call */
  text: string;
  /** Fully parsed tool calls */
  toolCalls: ParsedToolCall[];
  /** Tool calls detected but not safe to emit */
  invalidToolCalls: InvalidToolCall[];
}

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private TOOL_START = '<tool_call>';
  private TOOL_END = '</tool_call>';
  private emittedToolCallCount = 0;
  private readonly fallbackInvalidToolCallsToText: boolean;

  constructor(options: StreamingToolParserOptions = {}) {
    this.fallbackInvalidToolCallsToText = options.fallbackInvalidToolCallsToText ?? true;
  }

  private createFallbackText(rawToolJson: string): string {
    return `${this.TOOL_START}${rawToolJson}${this.TOOL_END}`;
  }

  private registerInvalidToolCall(
    result: ParserResult,
    rawToolJson: string,
    reason: InvalidToolCall['reason'],
  ): void {
    result.invalidToolCalls.push({ raw: rawToolJson, reason });

    if (this.fallbackInvalidToolCallsToText) {
      result.text += this.createFallbackText(rawToolJson);
    }
  }

  private extractToolCall(rawToolJson: string): ParsedToolCall | null {
    const parsed = robustParseJSON(rawToolJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const toolCallObj = parsed as ParsedToolPayload;
    const toolId = 'call_' + uuidv4();
    const toolName = typeof toolCallObj.name === 'string' ? toolCallObj.name : '';
    if (!toolName.trim()) {
      return null;
    }

    let toolArgs: Record<string, unknown> = {};

    if (toolCallObj.arguments !== undefined) {
      const parsedArguments = typeof toolCallObj.arguments === 'string'
        ? robustParseJSON(toolCallObj.arguments)
        : toolCallObj.arguments;

      if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
        return null;
      }

      toolArgs = parsedArguments as Record<string, unknown>;
    } else {
      const { name: _name, arguments: _arguments, ...rest } = toolCallObj;
      toolArgs = rest;
    }

    return {
      id: toolId,
      name: toolName,
      arguments: toolArgs,
    };
  }

  /**
   * Feeds a chunk of text into the parser and returns any extracted text and tool calls.
   */
  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = {
      text: '',
      toolCalls: [],
      invalidToolCalls: [],
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
            const toolCall = this.extractToolCall(toolJsonStr);
            if (toolCall) {
              result.toolCalls.push(toolCall);
              this.emittedToolCallCount++;
            } else {
              this.registerInvalidToolCall(result, toolJsonStr, 'invalid_payload');
            }
          } catch (e) {
            console.warn(`[StreamingToolParser] Parsing failed for: ${toolJsonStr}`, e);
            this.registerInvalidToolCall(result, toolJsonStr, 'parse_failed');
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
      invalidToolCalls: [],
    };

    if (this.buffer.length > 0) {
      if (this.insideTool) {
        // Try to parse partial tool call
        try {
          const toolCall = this.extractToolCall(this.buffer);
          if (toolCall) {
            result.toolCalls.push(toolCall);
            this.emittedToolCallCount++;
          } else {
            this.registerInvalidToolCall(result, this.buffer, 'invalid_payload');
          }
        } catch {
          this.registerInvalidToolCall(result, this.buffer, 'parse_failed');
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
