import type { FunctionToolDefinition, Message, OpenAIRequest, ToolChoice } from '../utils/types.ts';
import { getModelContextWindow } from './model-registry.ts';

export class OpenAIRequestError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;

  constructor(message: string, status = 400, options: {
    type?: string;
    code?: string | null;
    param?: string | null;
  } = {}) {
    super(message);
    this.name = 'OpenAIRequestError';
    this.status = status;
    this.type = options.type || 'invalid_request_error';
    this.code = options.code ?? null;
    this.param = options.param ?? null;
  }
}

export function openAIErrorBody(
  message: string,
  status = 500,
  options: { type?: string; code?: string | null; param?: string | null } = {}
) {
  return {
    error: {
      message,
      type: options.type || (status >= 500 ? 'server_error' : 'invalid_request_error'),
      param: options.param ?? null,
      code: options.code ?? null,
    },
  };
}

export function openAIErrorFrom(err: any, fallbackStatus = 500) {
  const status = err instanceof OpenAIRequestError
    ? err.status
    : (typeof err?.upstreamStatus === 'number' ? err.upstreamStatus : fallbackStatus);

  return {
    status,
    body: openAIErrorBody(err?.message || 'Internal server error', status, {
      type: err instanceof OpenAIRequestError ? err.type : undefined,
      code: err instanceof OpenAIRequestError
        ? err.code
        : (typeof err?.upstreamCode === 'string' ? err.upstreamCode : null),
      param: err instanceof OpenAIRequestError ? err.param : null,
    }),
  };
}

export function openAIJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

export async function parseJsonBody(request: Request): Promise<any> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    throw new OpenAIRequestError('Invalid JSON body', 400, {
      code: 'invalid_json',
    });
  }
}

export function normalizeChatRequest(raw: any): OpenAIRequest & Record<string, any> {
  const body = assertObject(raw, 'body');
  const model = normalizeRequiredString(body.model, 'model');
  const messages = normalizeMessages(body.messages, body);

  if (messages.length === 0) {
    throw new OpenAIRequestError('messages must contain at least one message', 400, {
      param: 'messages',
      code: 'missing_messages',
    });
  }

  return {
    ...body,
    model,
    messages,
    stream: toBoolean(body.stream, false),
    tools: normalizeTools(body.tools),
    tool_choice: normalizeToolChoice(body.tool_choice),
    stream_options: normalizeObject(body.stream_options) || undefined,
    response_format: normalizeObject(body.response_format) || undefined,
    provider_options: normalizeObject(body.provider_options ?? body.providerOptions) || undefined,
    parallel_tool_calls: body.parallel_tool_calls === undefined ? undefined : toBoolean(body.parallel_tool_calls, false),
    stop: normalizeStop(body.stop),
    seed: normalizeOptionalNumber(body.seed),
    user: normalizeOptionalString(body.user),
    metadata: normalizeObject(body.metadata) || undefined,
    max_tokens: normalizeOptionalNumber(body.max_tokens),
    max_completion_tokens: normalizeOptionalNumber(body.max_completion_tokens),
    temperature: normalizeOptionalNumber(body.temperature),
    top_p: normalizeOptionalNumber(body.top_p),
  };
}

export function normalizeResponsesRequest(raw: any): Record<string, any> {
  const body = assertObject(raw, 'body');
  const model = normalizeRequiredString(body.model, 'model');
  let input = body.input;

  if (input === undefined && Array.isArray(body.messages)) {
    input = normalizeMessages(body.messages, body).map((message) => ({
      type: 'message',
      role: message.role,
      content: message.content || '',
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    }));
  }
  if (input === undefined && typeof body.prompt === 'string') {
    input = body.prompt;
  }

  if (input === undefined) {
    throw new OpenAIRequestError('input is required for the Responses API', 400, {
      param: 'input',
      code: 'missing_input',
    });
  }

  return {
    ...body,
    model,
    input,
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    previous_response_id: normalizeOptionalString(body.previous_response_id ?? body.previousResponseId),
    stream: toBoolean(body.stream, false),
    store: body.store === undefined ? undefined : toBoolean(body.store, true),
    tools: normalizeResponsesTools(body.tools),
    tool_choice: normalizeResponsesToolChoice(body.tool_choice),
    response_format: normalizeObject(body.response_format) || undefined,
    provider_options: normalizeObject(body.provider_options ?? body.providerOptions) || undefined,
    parallel_tool_calls: body.parallel_tool_calls === undefined ? undefined : toBoolean(body.parallel_tool_calls, false),
    include: Array.isArray(body.include) ? body.include : undefined,
    truncation: normalizeOptionalString(body.truncation),
    reasoning: normalizeObject(body.reasoning) || undefined,
    seed: normalizeOptionalNumber(body.seed),
    user: normalizeOptionalString(body.user),
    metadata: normalizeObject(body.metadata) || undefined,
    max_output_tokens: normalizeOptionalNumber(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens),
    temperature: normalizeOptionalNumber(body.temperature),
    top_p: normalizeOptionalNumber(body.top_p),
  };
}

export function normalizeTools(tools: any): FunctionToolDefinition[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    throw new OpenAIRequestError('tools must be an array', 400, {
      param: 'tools',
      code: 'invalid_tools',
    });
  }

  const normalized = tools
    .map((tool, index) => normalizeTool(tool, `tools.${index}`))
    .filter((tool): tool is FunctionToolDefinition => Boolean(tool));

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeResponsesTools(tools: any): any[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) {
    throw new OpenAIRequestError('tools must be an array', 400, {
      param: 'tools',
      code: 'invalid_tools',
    });
  }

  const normalized = tools.map((tool, index) => {
    if (!tool || typeof tool !== 'object') {
      throw new OpenAIRequestError('tool entries must be objects', 400, {
        param: `tools.${index}`,
        code: 'invalid_tool',
      });
    }

    if (tool.function || tool.type === 'function') {
      return normalizeTool(tool, `tools.${index}`);
    }

    // Responses clients such as Codex may pass custom, namespace, or hosted
    // tool descriptors. Keep them accepted at the HTTP boundary; downstream
    // parser/instruction code only uses the function-like subset it can emulate.
    return tool;
  });

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeTool(tool: any, param = 'tools'): FunctionToolDefinition | null {
  if (!tool || typeof tool !== 'object') {
    throw new OpenAIRequestError('tool entries must be objects', 400, {
      param,
      code: 'invalid_tool',
    });
  }

  const source = tool.function && typeof tool.function === 'object'
    ? tool.function
    : tool;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) {
    throw new OpenAIRequestError('function tools require a name', 400, {
      param,
      code: 'missing_tool_name',
    });
  }

  return {
    type: 'function',
    function: {
      name,
      description: typeof source.description === 'string' ? source.description : '',
      parameters: normalizeToolParameters(
        source.parameters
          ?? source.inputSchema
          ?? source.input_schema
          ?? tool.inputSchema
          ?? source.schema
          ?? { type: 'object', properties: {}, additionalProperties: true }
      ),
      strict: typeof source.strict === 'boolean' ? source.strict : undefined,
    },
  };
}

export function getForcedToolName(toolChoice: any): string | null {
  const normalized = normalizeToolChoice(toolChoice);
  if (!normalized || typeof normalized === 'string') return null;
  return normalized.function?.name || null;
}

export function normalizeToolChoice(toolChoice: any): ToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  if (typeof toolChoice === 'string') {
    return { type: 'function', function: { name: toolChoice } };
  }
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'auto' || toolChoice.type === 'none' || toolChoice.type === 'required') {
      return toolChoice.type;
    }
    const name = typeof toolChoice.function?.name === 'string'
      ? toolChoice.function.name
      : (typeof toolChoice.name === 'string'
        ? toolChoice.name
        : (typeof toolChoice.toolName === 'string' ? toolChoice.toolName : ''));
    if (name) return { type: 'function', function: { name } };
  }
  throw new OpenAIRequestError('tool_choice must be auto, none, required, a tool name, or a function tool_choice object', 400, {
    param: 'tool_choice',
    code: 'invalid_tool_choice',
  });
}

export function normalizeResponsesToolChoice(toolChoice: any): any {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  if (typeof toolChoice === 'string') {
    return { type: 'function', function: { name: toolChoice } };
  }
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'auto' || toolChoice.type === 'none' || toolChoice.type === 'required') {
      return toolChoice.type;
    }
    if (toolChoice.type && toolChoice.type !== 'function') {
      return toolChoice;
    }
    return normalizeToolChoice(toolChoice);
  }
  throw new OpenAIRequestError('tool_choice must be auto, none, required, a tool name, or a tool choice object', 400, {
    param: 'tool_choice',
    code: 'invalid_tool_choice',
  });
}

export function normalizeModelObject(model: any, requestedId?: string) {
  const id = String(requestedId || model?.id || '').trim();
  const baseId = id.replace(/-no-thinking$/, '');
  const sourceContext = model?.info?.meta?.max_context_length
    ?? model?.context_window
    ?? model?.contextWindow;
  const contextWindow = typeof sourceContext === 'number'
    ? sourceContext
    : getModelContextWindow(baseId);
  const createdRaw = model?.info?.created_at ?? model?.created;
  const created = typeof createdRaw === 'number'
    ? (createdRaw > 1_000_000_000_000 ? Math.floor(createdRaw / 1000) : createdRaw)
    : Math.floor(Date.now() / 1000);
  const noThinking = id.endsWith('-no-thinking');

  return {
    id,
    object: 'model',
    created,
    owned_by: model?.owned_by || model?.ownedBy || 'qwen',
    name: noThinking
      ? `${model?.name || baseId} (No Thinking)`
      : (model?.name || id),
    context_window: contextWindow,
    max_tokens: contextWindow,
    max_output_tokens: 8192,
    capabilities: {
      chat_completions: true,
      responses: true,
      tools: true,
      tool_choice: true,
      parallel_tool_calls: false,
      reasoning: !noThinking,
      images: false,
      prompt_cache_key: false,
      ...(model?.info?.meta?.capabilities && typeof model.info.meta.capabilities === 'object'
        ? model.info.meta.capabilities
        : {}),
    },
    supports_tools: true,
    supports_images: false,
    supports_reasoning: !noThinking,
    qwenproxy: {
      upstream_model: baseId,
      thinking_enabled: !noThinking,
      routes: ['/v1/chat/completions', '/v1/responses'],
    },
  };
}

export function normalizeModelList(data: any) {
  const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const normalized = models
    .filter((model: any) => typeof model?.id === 'string' && model.id.trim())
    .flatMap((model: any) => [
      normalizeModelObject(model, model.id),
      normalizeModelObject(model, `${model.id}-no-thinking`),
    ]);

  return {
    object: 'list',
    data: normalized,
  };
}

function normalizeMessages(messages: any, body: Record<string, any>): Message[] {
  const rawMessages = Array.isArray(messages)
    ? messages
    : fallbackMessages(body);

  return rawMessages
    .map((message: any, index: number) => normalizeMessage(message, `messages.${index}`))
    .filter((message): message is Message => Boolean(message));
}

function fallbackMessages(body: Record<string, any>): any[] {
  const messages: any[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (typeof body.prompt === 'string') {
    messages.push({ role: 'user', content: body.prompt });
  }
  return messages;
}

function normalizeMessage(raw: any, param: string): Message | null {
  if (!raw || typeof raw !== 'object') {
    throw new OpenAIRequestError('message entries must be objects', 400, {
      param,
      code: 'invalid_message',
    });
  }

  const role = normalizeRole(raw.role);
  const message: Message = {
    role,
    content: normalizeContent(raw.content),
  };

  if (typeof raw.name === 'string') message.name = raw.name;
  if (typeof raw.tool_call_id === 'string') message.tool_call_id = raw.tool_call_id;
  if (typeof raw.call_id === 'string') message.tool_call_id = raw.call_id;
  if (typeof raw.reasoning_content === 'string') message.reasoning_content = raw.reasoning_content;
  if (Array.isArray(raw.tool_calls)) {
    message.tool_calls = raw.tool_calls.map((call: any, index: number) => normalizeMessageToolCall(call, `${param}.tool_calls.${index}`));
  }

  return message;
}

function normalizeMessageToolCall(call: any, param: string) {
  if (!call || typeof call !== 'object') {
    throw new OpenAIRequestError('tool_calls entries must be objects', 400, {
      param,
      code: 'invalid_tool_call',
    });
  }
  const name = typeof call.function?.name === 'string'
    ? call.function.name
    : (typeof call.name === 'string' ? call.name : 'tool');
  const args = call.function?.arguments ?? call.arguments ?? call.input ?? {};

  return {
    id: typeof call.id === 'string' ? call.id : (typeof call.call_id === 'string' ? call.call_id : `call_${crypto.randomUUID()}`),
    type: 'function' as const,
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  };
}

function normalizeRole(role: any): string {
  if (role === 'developer') return 'system';
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool' || role === 'function') return role;
  return 'user';
}

function normalizeContent(content: any): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(normalizeContentPart).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.output_text === 'string') return content.output_text;
    if (typeof content.output === 'string') return content.output;
    return JSON.stringify(content);
  }
  return String(content);
}

function normalizeContentPart(part: any): string {
  if (part === null || part === undefined) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return String(part);
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.output === 'string') return part.output;
  if (part.type === 'image_url' || part.type === 'input_image') return '[Image input]';
  if (part.type === 'file') return `[File input${part.mediaType ? `: ${part.mediaType}` : ''}]`;
  if (part.type === 'tool-call' || part.type === 'tool_call') {
    const name = part.toolName || part.name || part.function?.name || 'tool';
    const input = part.input ?? part.args ?? part.arguments ?? part.function?.arguments ?? {};
    return `[Tool call: ${name} ${typeof input === 'string' ? input : JSON.stringify(input)}]`;
  }
  if (part.type === 'tool-result') return normalizeContent(part.output ?? part.result ?? part.content) || '';
  return JSON.stringify(part);
}

function normalizeToolParameters(parameters: any): any {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  if (!parameters.type) {
    return { type: 'object', properties: parameters.properties || {}, ...parameters };
  }
  return parameters;
}

function normalizeObject(value: any): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function normalizeOptionalString(value: any): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeStop(value: any): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 16);
  }
  throw new OpenAIRequestError('stop must be a string or an array of strings', 400, {
    param: 'stop',
    code: 'invalid_stop',
  });
}

function normalizeRequiredString(value: any, param: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OpenAIRequestError(`${param} is required`, 400, {
      param,
      code: `missing_${param}`,
    });
  }
  return value.trim();
}

function assertObject(value: any, param: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAIRequestError(`${param} must be a JSON object`, 400, {
      param,
      code: 'invalid_request_body',
    });
  }
  return value;
}

function toBoolean(value: any, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return Boolean(value);
}
