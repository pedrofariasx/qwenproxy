/*
 * File: qwen-stream-parser.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-06-02
 *
 * Shared SSE parser for Qwen stream responses.
 * Eliminates duplication between streaming and non-streaming code paths.
 */

import { updateSessionParent } from '../services/qwen.js';
import { getIncrementalDelta } from '../routes/chat.js';
import { StreamingToolParser } from '../tools/parser.js';
import type { FunctionToolDefinition } from '../tools/types.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from '../routes/tool-handler.js';

export interface QwenStreamDelta {
  phase: string;
  content?: string;
  extra?: {
    summary_thought?: {
      content: string[];
    };
  };
}

export interface QwenStreamChunk {
  'response.created'?: {
    response_id: string;
  };
  response_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  choices?: Array<{
    delta: QwenStreamDelta;
  }>;
}

export interface ParsedChunkResult {
  /** The extracted content string (delta for thinking or answer phase). Empty if none. */
  content: string;
  /** True if this chunk belongs to the thinking/reasoning phase. */
  isThinking: boolean;
}

export interface StreamParserState {
  targetResponseId: string | null;
  currentThoughtIndex: number;
  lastFullContent: string;
  reasoningBuffer: string;
  promptTokens: number;
  completionTokens: number;
}

export interface QwenStreamParseOptions {
  /** Tool definitions for the streaming tool parser. Pass [] or null to disable tool parsing. */
  tools?: FunctionToolDefinition[];
  /** Callback invoked when a response_id is discovered. */
  onTargetResponseId?: (responseId: string, uiSessionId: string) => void;
  /** Callback invoked for each parsed thinking content delta. */
  onThinking?: (content: string) => void;
  /** Callback invoked for each parsed answer content delta. */
  onAnswer?: (content: string) => void;
  /** Callback invoked for each tool call parsed from the answer stream. */
  onToolCall?: (toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => void;
}

/**
 * QwenStreamParser handles parsing of Qwen's SSE stream chunks for both
 * streaming and non-streaming response modes.
 *
 * It extracts:
 * - response_id for session tracking
 * - usage statistics (input/output tokens)
 * - thinking_summary content (reasoning)
 * - answer content (final response text)
 * - tool calls embedded in the answer stream
 */
export class QwenStreamParser {
  private readonly uiSessionId: string;
  private readonly options: Required<Pick<QwenStreamParseOptions, 'tools'>> & Omit<QwenStreamParseOptions, 'tools'>;

  private _state: StreamParserState;
  private toolParser: StreamingToolParser | null;
  private readonly bufferAccumulator: string[] = [];
  private _contentLength: number = 0;
  private _contentSuffix: string = '';

  constructor(uiSessionId: string, options: QwenStreamParseOptions = {}) {
    this.uiSessionId = uiSessionId;
    this.options = {
      tools: options.tools ?? [],
      onTargetResponseId: options.onTargetResponseId,
      onThinking: options.onThinking,
      onAnswer: options.onAnswer,
      onToolCall: options.onToolCall,
    };

    this._state = {
      targetResponseId: null,
      currentThoughtIndex: 0,
      lastFullContent: '',
      reasoningBuffer: '',
      promptTokens: 0,
      completionTokens: 0,
    };

    this.toolParser = this.options.tools && this.options.tools.length > 0
      ? new StreamingToolParser(this.options.tools)
      : null;
  }

  /** Get the current parser state (read-only). */
  get state(): Readonly<StreamParserState> {
    return this._state;
  }

  /** Get accumulated reasoning buffer. */
  get reasoningBuffer(): string {
    return this._state.reasoningBuffer;
  }

  /** Get accumulated answer content. */
  get answerContent(): string {
    return this._state.lastFullContent;
  }

  /** Get token usage statistics. */
  get usage(): { promptTokens: number; completionTokens: number } {
    return {
      promptTokens: this._state.promptTokens,
      completionTokens: this._state.completionTokens,
    };
  }

  /**
   * Process a single raw SSE line (the part after "data: ").
   * Returns the parsed result, or null if the line should be skipped.
   */
  parseLine(rawData: string): ParsedChunkResult | null {
    if (rawData === '[DONE]') return null;

    let chunk: QwenStreamChunk;
    try {
      chunk = JSON.parse(rawData);
    } catch {
      return null; // Partial/malformed chunk, skip
    }

    // Track response_id for session continuity
    this.updateResponseId(chunk);

    // Track token usage
    this.updateUsage(chunk);

    // Extract content delta
    const delta = this.extractDelta(chunk);
    if (!delta) return null;

    if (delta.content === 'FINISHED') return null;

    if (delta.isThinking) {
      this._state.reasoningBuffer += delta.content;
      this.options.onThinking?.(delta.content);
    } else {
      const deltaResult = getIncrementalDelta(
        this._state.lastFullContent,
        delta.content,
        this._contentLength,
        this._contentSuffix
      );
      const actualDelta = deltaResult.delta;
      this._state.lastFullContent = deltaResult.matchedContent;
      this._contentLength = deltaResult.contentLength;
      this._contentSuffix = deltaResult.contentSuffix;

      if (this.toolParser) {
        const { text, toolCalls } = this.toolParser.feed(actualDelta);
        for (const tc of toolCalls) {
          this.options.onToolCall?.({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
        if (text) {
          this.options.onAnswer?.(text);
        }
      } else {
        if (actualDelta) {
          this.options.onAnswer?.(actualDelta);
        }
      }
    }

    return delta;
  }

  /**
   * Feed accumulated buffer content and return any remaining text/tool calls
   * that were not fully parsed (useful for flushing at end of stream).
   */
  flush(): { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } {
    if (this.toolParser) {
      const flushed = this.toolParser.flush();
      if (flushed.text && looksLikeUnwrappedToolCall(flushed.text)) {
        return { text: '', toolCalls: [...flushed.toolCalls, ...parseUnwrappedToolCalls(flushed.text)] };
      }
      return flushed;
    }
    return { text: '', toolCalls: [] };
  }

  /**
   * Reset the parser state for reuse with a new stream.
   */
  reset(): void {
    this._state = {
      targetResponseId: null,
      currentThoughtIndex: 0,
      lastFullContent: '',
      reasoningBuffer: '',
      promptTokens: this._state.promptTokens,
      completionTokens: this._state.completionTokens,
    };
    this._contentLength = 0;
    this._contentSuffix = '';
    this.toolParser = this.options.tools && this.options.tools.length > 0
      ? new StreamingToolParser(this.options.tools)
      : null;
  }

  // -- Private helpers --

  private updateResponseId(chunk: QwenStreamChunk): void {
    if (chunk['response.created'] && chunk['response.created'].response_id) {
      if (!this._state.targetResponseId) {
        this._state.targetResponseId = chunk['response.created'].response_id;
      }
      updateSessionParent(this.uiSessionId, chunk['response.created'].response_id);
      this.options.onTargetResponseId?.(chunk['response.created'].response_id, this.uiSessionId);
    } else if (chunk.response_id && !this._state.targetResponseId) {
      this._state.targetResponseId = chunk.response_id;
      updateSessionParent(this.uiSessionId, chunk.response_id);
      this.options.onTargetResponseId?.(chunk.response_id, this.uiSessionId);
    }
  }

  private updateUsage(chunk: QwenStreamChunk): void {
    if (chunk.usage) {
      if (chunk.usage.output_tokens) {
        this._state.completionTokens = chunk.usage.output_tokens;
      }
      if (chunk.usage.input_tokens) {
        this._state.promptTokens = chunk.usage.input_tokens;
      }
    }
  }

  private extractDelta(chunk: QwenStreamChunk): ParsedChunkResult | null {
    if (!chunk.choices || !chunk.choices[0] || !chunk.choices[0].delta) {
      return null;
    }

    // Filter by target response_id if one has been established
    if (this._state.targetResponseId !== null && chunk.response_id !== this._state.targetResponseId) {
      return null;
    }

    const delta = chunk.choices[0].delta;

    if (delta.phase === 'thinking_summary') {
      if (delta.extra?.summary_thought?.content) {
        const thoughts = delta.extra.summary_thought.content;
        if (thoughts.length > this._state.currentThoughtIndex) {
          const content = thoughts.slice(this._state.currentThoughtIndex).join('\n');
          this._state.currentThoughtIndex = thoughts.length;
          return { content, isThinking: true };
        }
      }
      return null;
    }

    if (delta.phase === 'answer') {
      const content = delta.content ?? '';
      return { content, isThinking: false };
    }

    return null;
  }
}
