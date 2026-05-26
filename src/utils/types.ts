/*
 * File: types.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

// --- JSON Schema ---

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  nullable?: boolean;
}

// --- Function Tool Definitions ---

export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/** Tool choice options */
export type ToolChoice = 'auto' | 'none' | 'required' | {
  type: 'function';
  function: { name: string };
};

// --- Message Types ---

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface MessageToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface Message {
  role: string;
  content: string | null;
  tool_calls?: MessageToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

// --- Request Types ---

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  stream_options?: {
    include_usage?: boolean;
  };
}

// --- Response Types ---

export interface ToolCall {
  index: number;
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface Choice {
  index: number;
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

// --- Tool System Types ---

export interface ToolRegistration {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
  handler: ToolHandler;
}

export type ToolHandler<TArgs = any, TResult = any> = (
  args: TArgs,
  context: ToolContext
) => Promise<TResult>;

export interface ToolContext {
  messages: unknown[];
  turn: number;
  model: string;
  [key: string]: any;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}
