/*
 * File: types.ts
 * Project: qwenproxy
 * Tool system types
 *
 * Re-exports base types from src/types/openai.ts (single source of truth).
 * Keeps ONLY tool-execution-specific types defined locally.
 */

// ─── Re-export base types from openai.ts ─────────────────────────────────
export type { JsonSchema, FunctionToolDefinition } from '../types/openai.ts';
// Local import for use in local type definitions below
import type { JsonSchema } from '../types/openai.ts';

// ─── Type re-exports for convenience ─────────────────────────────────────
export type {
  ToolChoice,
  ToolCallFunction,
  MessageToolCall,
  Message,
  OpenAIRequest,
  ToolCallDelta,
  ChoiceDelta,
  Choice,
  Usage,
  ChatCompletionChunk,
} from '../types/openai.ts';

// ─── Tool-specific types (NOT re-exported from openai.ts) ─────────────────

/**
 * Internal tool registration entry.
 */
export interface ToolRegistration {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
  handler: ToolHandler;
}

/**
 * Handler function signature for a registered tool.
 * Receives the parsed and validated arguments.
 * Returns the result.
 */
export type ToolHandler<TArgs = Record<string, unknown>, TResult = unknown> = (
  args: TArgs,
  context: ToolContext,
  signal?: AbortSignal
) => Promise<TResult>;

/**
 * Context passed to tool handlers during execution.
 */
export interface ToolContext {
  /** The original messages from the request */
  messages: unknown[];
  /** The current turn number in the execution loop */
  turn: number;
  /** The model being used */
  model: string;
  /** Custom state or services can be attached here */
  [key: string]: any;
}

/**
 * A parsed tool call from the LLM response.
 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a single tool call.
 */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}
