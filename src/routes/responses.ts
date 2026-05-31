/*
 * #==========# Responses route
 * OpenAI Responses-style adapter with live SSE passthrough to Qwen.
 * Keeps the proxy isolated from completions internals.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'hono';
import { createQwenStream, stopQwenGeneration, updateSessionParent } from '../services/qwen.ts';
import type { Message, OpenAIRequest, FunctionToolDefinition } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { getIncrementalDelta } from './chat.ts';
import { getModelContextWindow } from '../core/model-registry.js';
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, abortStream } from '../core/stream-registry.ts';
import { Mutex } from '../services/playwright.ts';
import { getResponseContext, getSessionResponseId, pruneResponseContexts, storeResponseContext } from '../core/response-store.ts';
import { createDebugTrace, detectClientName } from '../core/debug-console.ts';
import { terminal } from '../core/terminal.ts';
import {
  normalizeResponsesRequest,
  openAIErrorBody,
  openAIErrorFrom,
  openAIJsonResponse,
  parseJsonBody,
} from '../core/openai-compat.ts';

type ResponsesInputItem = string | Record<string, any>;
type ResponsesToolDefinition = Record<string, any>;

interface ResponsesRequestBody {
  model: string;
  input?: ResponsesInputItem | ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string;
  stream?: boolean;
  store?: boolean;
  tools?: ResponsesToolDefinition[];
  tool_choice?: OpenAIRequest['tool_choice'] | Record<string, any> | string;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
  max_output_tokens?: number;
}

type QwenChunk = {
  response_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  choices?: Array<{ delta?: { phase?: string; content?: string; extra?: any } }>;
  ['response.created']?: { response_id?: string };
};

const QWEN_STREAM_IDLE_TIMEOUT_MS = 90_000;

class UpstreamIdleTimeoutError extends Error {
  upstreamStatus = 504;

  constructor() {
    super(`Qwen stream produced no data for ${Math.round(QWEN_STREAM_IDLE_TIMEOUT_MS / 1000)}s`);
    this.name = 'UpstreamIdleTimeoutError';
  }
}

class ClientStreamClosedError extends Error {
  constructor() {
    super('Responses stream was closed by the client');
    this.name = 'ClientStreamClosedError';
  }
}

function isStreamClosedError(err: any): boolean {
  return err instanceof ClientStreamClosedError
    || err?.code === 'ERR_INVALID_STATE'
    || /Controller is already closed/i.test(String(err?.message || ''));
}

function responseErrorPayload(err: any, fallbackMessage = 'responses stream failed') {
  const status = typeof err?.upstreamStatus === 'number'
    ? err.upstreamStatus
    : (err instanceof UpstreamIdleTimeoutError ? err.upstreamStatus : 500);
  const code = typeof err?.upstreamCode === 'string'
    ? err.upstreamCode
    : (err instanceof UpstreamIdleTimeoutError ? 'upstream_idle_timeout' : 'internal_error');

  return {
    message: err?.message || fallbackMessage,
    type: status >= 500 ? 'server_error' : 'invalid_request_error',
    code,
    param: null,
  };
}

async function readQwenChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = QWEN_STREAM_IDLE_TIMEOUT_MS
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new UpstreamIdleTimeoutError()), timeoutMs);
    timeoutHandle?.unref?.();
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function toolName(tool: any): string {
  if (!tool || typeof tool !== 'object') return '';
  if (tool.type === 'function') {
    return typeof tool.name === 'string' ? tool.name : (typeof tool.function?.name === 'string' ? tool.function.name : '');
  }
  if (typeof tool.name === 'string') return tool.name;
  if (typeof tool.function?.name === 'string') return tool.function.name;
  return '';
}

function normalizeToolDefinition(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;

  if (tool.type === 'function') {
    const source = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = typeof source.name === 'string' ? source.name : '';
    if (!name) return tool;
    return {
      type: 'function',
      name,
      description: typeof source.description === 'string' ? source.description : '',
      parameters: source.parameters ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    };
  }

  return tool;
}

function toolDefinitionsForParser(tools: ResponsesToolDefinition[] | undefined): FunctionToolDefinition[] {
  if (!Array.isArray(tools)) return [];

  return tools
    .map((tool: any) => {
      const name = toolName(tool);
      if (!name) return null;
      if (tool.type === 'function') {
        const normalized = normalizeToolDefinition(tool);
        return {
          type: 'function',
          function: {
            name: normalized.name,
            description: normalized.description || '',
            parameters: normalized.parameters ?? {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
          },
        } as FunctionToolDefinition;
      }
      return {
        type: 'function',
        function: {
          name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.parameters ?? {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      } as FunctionToolDefinition;
    })
    .filter((tool): tool is FunctionToolDefinition => Boolean(tool));
}

function getForcedToolName(toolChoice: any): string | null {
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return null;
  if (typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice.name === 'string') return toolChoice.name;
  if (typeof toolChoice.function?.name === 'string') return toolChoice.function.name;
  return null;
}

function responseSessionKey(metadata: Record<string, unknown> | undefined): string | null {
  const sessionId = typeof metadata?.session_id === 'string' ? metadata.session_id.trim() : '';
  if (!sessionId) return null;
  const projectKey = typeof metadata?.project_key === 'string' ? metadata.project_key.trim() : '';
  return projectKey ? `${projectKey}:${sessionId}` : sessionId;
}

function responseItemFromToolCall(tc: any): any {
  return {
    type: 'function_call',
    id: tc.id,
    call_id: tc.id,
    status: 'completed',
    name: tc.name,
    arguments: JSON.stringify(tc.arguments),
  };
}

function responseItemToMessageToolCall(item: any) {
  const args = typeof item.arguments === 'string'
    ? item.arguments
    : JSON.stringify(item.arguments ?? {});

  return {
    id: item.call_id || item.id || `call_${uuidv4()}`,
    type: 'function' as const,
    function: {
      name: item.name || 'tool',
      arguments: args,
    },
  };
}

function assistantContextMessage(content: string, toolItems: any[]): Message {
  const message: Message = {
    role: 'assistant',
    content: content || null,
  };

  if (toolItems.length > 0) {
    message.tool_calls = toolItems
      .filter((item) => item?.type === 'function_call')
      .map(responseItemToMessageToolCall);
  }

  return message;
}

function writeToolCallEvents(
  controller: ReadableStreamDefaultController,
  responseId: string,
  outputIndex: number,
  item: any,
  writeEvent: (controller: ReadableStreamDefaultController, event: string, payload: unknown) => void
) {
  const pendingItem = { ...item, status: 'in_progress', arguments: '' };
  writeEvent(controller, 'response.output_item.added', {
    response_id: responseId,
    output_index: outputIndex,
    item: pendingItem,
  });
  writeEvent(controller, 'response.function_call_arguments.delta', {
    response_id: responseId,
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    delta: item.arguments,
  });
  writeEvent(controller, 'response.function_call_arguments.done', {
    response_id: responseId,
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    arguments: item.arguments,
  });
  writeEvent(controller, 'response.output_item.done', {
    response_id: responseId,
    output_index: outputIndex,
    item,
  });
}

const accountMutexes = new Map<string, Mutex>();

function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return openAIJsonResponse(payload, status);
}

function eventPayload(event: string, data: unknown, sequenceNumber: number): string {
  return `event: ${event}\ndata: ${JSON.stringify(responseStreamPayload(event, data, sequenceNumber))}\n\n`;
}

function responseStreamPayload(event: string, data: unknown, sequenceNumber: number): Record<string, unknown> {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const payload = { ...(data as Record<string, unknown>) };
    delete payload.type;
    delete payload.sequence_number;

    return {
      type: event,
      sequence_number: sequenceNumber,
      ...payload,
    };
  }

  return {
    type: event,
    sequence_number: sequenceNumber,
    data,
  };
}

function normalizeContentPart(part: any): string {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
  if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
  if (part.type === 'input_image') return '[Image input]';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.output === 'string') return part.output;
  if (typeof part.value === 'string') return part.value;
  if (typeof part.content === 'string') return part.content;
  return JSON.stringify(part);
}

function normalizeRole(role: string | undefined): Message['role'] {
  if (role === 'developer') return 'developer';
  if (role === 'system') return 'developer';
  if (role === 'tool') return 'tool';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

function normalizeInputItem(item: ResponsesInputItem): Message[] {
  if (typeof item === 'string') {
    return [{ role: 'user', content: item }];
  }

  if (item && typeof item === 'object') {
    if (item.type === 'message') {
      const role = normalizeRole(item.role);
      const content = Array.isArray(item.content)
        ? item.content.map(normalizeContentPart).join('\n')
        : normalizeContentPart(item.content);

      const message: Message = { role, content };
      if (role === 'tool' && item.call_id) {
        message.tool_call_id = item.call_id;
      }
      if (item.name) {
        message.name = item.name;
      }
      return [message];
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const name = item.name || item.function?.name || 'tool';
      const args = item.arguments ?? item.input ?? item.function?.arguments ?? {};
      return [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.id || item.call_id || `call_${uuidv4()}`,
          type: 'function',
          function: {
            name,
            arguments: typeof args === 'string'
              ? args
              : JSON.stringify(args),
          },
        }],
      }];
    }

    if (
      item.type === 'function_call_output'
      || item.type === 'custom_tool_call_output'
      || item.type === 'tool_result'
    ) {
      return [{
        role: 'tool',
        content: normalizeContentPart(item.output ?? item.content ?? item.status ?? ''),
        tool_call_id: item.call_id || item.tool_call_id || item.id,
        name: item.name,
      }];
    }

    if (item.role) {
      const role = normalizeRole(item.role);
      const content = Array.isArray(item.content)
        ? item.content.map(normalizeContentPart).join('\n')
        : normalizeContentPart(item.content);
      const message: Message = { role, content };
      if (role === 'tool' && item.tool_call_id) {
        message.tool_call_id = item.tool_call_id;
      }
      if (item.name) {
        message.name = item.name;
      }
      if (role === 'assistant' && Array.isArray(item.tool_calls)) {
        message.tool_calls = item.tool_calls.map((call: any) => ({
          id: call.id || `call_${uuidv4()}`,
          type: 'function',
          function: {
            name: call.function?.name || call.name || 'tool',
            arguments: typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
          },
        }));
      }
      return [message];
    }
  }

  return [];
}

function buildPrompt(messages: Message[]): string {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'developer') {
      systemPrompt += `${contentStr}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `User: ${contentStr}\n\n`;
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr;
      const reasoning = (msg as any).reasoning_content;
      if (reasoning) {
        assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
      }
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments;
          let parsedArgs: any = {};
          if (typeof args === 'string') {
            try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
          } else if (args && typeof args === 'object') {
            parsedArgs = args;
          }
          const payload = { name: tc.function?.name, arguments: parsedArgs };
          const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
          assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`;
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        // Resolve tool name from previous assistant tool_calls if possible.
        for (let i = messages.indexOf(msg) - 1; i >= 0; i--) {
          const prevMsg = messages[i];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find((tc) => tc.id === msg.tool_call_id);
            if (call) {
              toolName = call.function?.name;
              break;
            }
          }
        }
      }
      prompt += `Tool Response (${toolName || 'tool'}): ${contentStr}\n\n`;
    }
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}

function injectToolInstructions(systemPrompt: string, body: ResponsesRequestBody): string {
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) return systemPrompt;

  const formattedTools = body.tools.map(normalizeToolDefinition);

  const toolsJson = JSON.stringify(formattedTools, null, 2);
  let next = `${systemPrompt}\n\n# TOOLS AVAILABLE\nYou have access to the following client-side tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo request a tool, output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nCRITICAL RULES:\n1. The client executes tools; you only request them.\n2. You may request multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. When requesting tools, do not add explanatory text after the tool call blocks.\n4. The JSON inside the tags must be valid and include the "name" and "arguments" fields.\n`;

  const forcedTool = getForcedToolName(body.tool_choice);
  if (forcedTool) {
    next += `\nCRITICAL: You MUST call the tool "${forcedTool}" in this response.\n`;
  }

  return next;
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

function buildResponseEnvelope(params: {
  id: string;
  createdAt: number;
  model: string;
  body: ResponsesRequestBody;
  previousResponseId: string | null;
  output: any[];
  outputText: string;
  usage?: any;
  status?: 'completed' | 'cancelled' | 'failed' | 'incomplete';
  error?: any;
}) {
  return {
    id: params.id,
    object: 'response',
    created_at: params.createdAt,
    status: params.status ?? 'completed',
    error: params.error ?? null,
    incomplete_details: null,
    instructions: params.body.instructions ?? null,
    model: params.model,
    output: params.output,
    output_text: params.outputText,
    previous_response_id: params.previousResponseId,
    parallel_tool_calls: true,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: params.body.store ?? true,
    temperature: params.body.temperature ?? null,
    top_p: params.body.top_p ?? null,
    truncation: 'disabled',
    tool_choice: params.body.tool_choice ?? 'auto',
    tools: params.body.tools ?? [],
    metadata: params.body.metadata ?? {},
    max_output_tokens: params.body.max_output_tokens ?? null,
    usage: params.usage,
  };
}

function buildMinimalCancelledResponse(responseId: string, model = 'unknown', previousResponseId: string | null = null) {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'cancelled',
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: [],
    output_text: '',
    previous_response_id: previousResponseId,
    parallel_tool_calls: true,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: true,
    temperature: null,
    top_p: null,
    truncation: 'disabled',
    tool_choice: 'auto',
    tools: [],
    metadata: {},
    max_output_tokens: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

async function acquireQwenStream(prompt: string, model: string, streamKey: string) {
  const modelId = model.replace('-no-thinking', '');
  const modelContextWindow = getModelContextWindow(modelId);
  const estimatedTokens = estimateTokenCount(prompt);
  const promptToSend = estimatedTokens > modelContextWindow - 1000
    ? truncateMessages([{ role: 'user', content: prompt }], modelContextWindow, '')
        .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`)
        .join('\n\n')
    : prompt;

  let account = getNextAccount();
  let triedAccountIds = new Set<string>();
  let lastError: any = null;

  while (account) {
    const accountId = account.id;
    const accountEmail = account.email;

    if (triedAccountIds.has(accountId)) {
      account = getNextAvailableAccount(accountId);
      continue;
    }
    triedAccountIds.add(accountId);

    const cooldownInfo = getAccountCooldownInfo(accountId);
    if (cooldownInfo && accountId !== 'global') {
      terminal.warn('Responses', `Skipping ${accountEmail}; account on cooldown`, [
        `remaining: ${Math.round(cooldownInfo.remainingMs / 1000)}s`,
        `reason: ${cooldownInfo.reason}`,
      ]);
      account = getNextAvailableAccount(accountId);
      continue;
    }

    terminal.info('Responses', `Routing request to ${accountEmail}`, [`id: ${accountId}`]);

    const accountMutex = getAccountMutex(accountId);
    const release = await accountMutex.acquire();

    try {
      let retries = 3;
      let retryDelay = 500;
      while (retries > 0) {
        try {
          const result = await createQwenStream(
            promptToSend,
            !model.includes('no-thinking'),
            model,
            null,
            accountId === 'global' ? undefined : accountId
          );
          registerStream(streamKey, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
          });
          release();
          return { ...result, accountId: result.accountId };
        } catch (err: any) {
          retries--;

          if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
            const hourHint = err.message?.match(/Wait about (\d+) hour/);
            const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
            markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
            release();
            lastError = err;
            break;
          }

          if (retries === 0) {
            if (err.upstreamStatus && err.upstreamStatus >= 500) {
              markAccountRateLimited(accountId, undefined, 'ServerError');
            }
            release();
            lastError = err;
            break;
          }

          const isRetryable = err.message?.includes('in progress') || err.message?.includes('Bad_Request');
          if (!isRetryable) {
            release();
            lastError = err;
            break;
          }

          await new Promise((r) => setTimeout(r, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 5000);
        }
      }

      release();
      account = getNextAvailableAccount(accountId);
    } catch (err: any) {
      release();
      lastError = err;
      account = getNextAvailableAccount(accountId);
    }
  }

  throw lastError || new Error('All accounts failed');
}

function isAbortError(err: any): boolean {
  return err?.name === 'AbortError'
    || err?.code === 'ABORT_ERR'
    || /abort|cancel/i.test(String(err?.message || ''));
}

async function stopQwenStreamIfKnown(qwen: {
  uiSessionId: string;
  headers: Record<string, string>;
  controller: AbortController;
}, responseId: string | null): Promise<void> {
  if (qwen.uiSessionId && responseId) {
    await stopQwenGeneration(qwen.uiSessionId, responseId, qwen.headers).catch((err: any) => {
      terminal.warn('Responses', 'Failed to stop upstream generation cleanly', [err.message]);
    });
  }
  qwen.controller.abort();
}

async function handleResponses(
  body: ResponsesRequestBody,
  stream: boolean,
  responseId: string,
  clientName = 'cliente desconhecido'
): Promise<Response> {
  const sessionKey = responseSessionKey(body.metadata);
  const previousResponseId = body.previous_response_id ?? getSessionResponseId(sessionKey) ?? null;
  const debugTrace = createDebugTrace({
    id: responseId,
    route: 'responses',
    client: clientName,
    model: body.model,
    stream,
    input: body.input,
    tools: body.tools,
    previousResponseId,
    sessionKey,
  });
  const history = getResponseContext(previousResponseId);
  const inputMessages: Message[] = [];
  if (body.instructions) {
    inputMessages.push({ role: 'developer', content: body.instructions });
  }
  inputMessages.push(...history);

  const rawInput = Array.isArray(body.input) ? body.input : (body.input !== undefined ? [body.input] : []);
  for (const item of rawInput) {
    inputMessages.push(...normalizeInputItem(item));
  }

  const systemPrompt = injectToolInstructions('', body);
  const prompt = buildPrompt(inputMessages);
  const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
  const promptTokenEstimate = Math.ceil(finalPrompt.length / 3.5);
  debugTrace.prompt(finalPrompt, { estimatedTokens: promptTokenEstimate });

  const startedAt = Math.floor(Date.now() / 1000);
  const assistantOutputItems: any[] = [];
  let assistantText = '';
  let reasoningBuffer = '';
  let currentThoughtIndex = 0;
  let buffer = '';
  let completionTokens = 0;
  let promptTokens = promptTokenEstimate;
  let targetResponseId: string | null = null;

  const assistantMessage: Message = { role: 'assistant', content: null };
  const responseOutput: any[] = [];
  let assistantItemId = `msg_${uuidv4().replace(/-/g, '')}`;
  let assistantItemAdded = false;

  type ActiveQwenStream = Awaited<ReturnType<typeof acquireQwenStream>>;
  const streamState: {
    closed: boolean;
    cancelled: boolean;
    qwen: ActiveQwenStream | null;
    reader: ReadableStreamDefaultReader<Uint8Array> | null;
    targetResponseId: string | null;
  } = {
    closed: false,
    cancelled: false,
    qwen: null,
    reader: null,
    targetResponseId: null,
  };
  const sseEncoder = new TextEncoder();
  let sequenceNumber = 0;

  const writeRaw = (controller: ReadableStreamDefaultController, text: string) => {
    if (streamState.closed || streamState.cancelled) {
      throw new ClientStreamClosedError();
    }
    try {
      controller.enqueue(sseEncoder.encode(text));
    } catch (err: any) {
      if (isStreamClosedError(err)) {
        streamState.closed = true;
        throw new ClientStreamClosedError();
      }
      throw err;
    }
  };

  const writeEvent = (controller: ReadableStreamDefaultController, event: string, payload: unknown) => {
    writeRaw(controller, eventPayload(event, payload, sequenceNumber++));
  };

  const writeDone = (controller: ReadableStreamDefaultController) => {
    // Responses API streams are event-typed JSON streams. The final
    // response.completed event plus closing the stream is the terminator.
  };

  const closeStream = (controller: ReadableStreamDefaultController) => {
    if (streamState.closed) return;
    streamState.closed = true;
    try {
      controller.close();
    } catch (err: any) {
      if (!isStreamClosedError(err)) throw err;
    }
  };

  const buildUsage = () => ({
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });

  const runStream = async (controller: ReadableStreamDefaultController) => {
    const qwen = await acquireQwenStream(finalPrompt, body.model, responseId);
    streamState.qwen = qwen;
    if (streamState.cancelled) {
      await stopQwenStreamIfKnown(qwen, null);
      removeStream(responseId);
      return;
    }
    const reader = qwen.stream.getReader();
    streamState.reader = reader;
    const decoder = new TextDecoder();
    const toolParser = new StreamingToolParser(toolDefinitionsForParser(body.tools));
    let streamBuffer = '';
    let streamCompletionTokens = 0;
    let streamPromptTokens = Math.ceil(finalPrompt.length / 3.5);
    let streamTargetResponseId: string | null = null;
    let streamAssistantText = '';
    let streamReasoningBuffer = '';
    let streamCurrentThoughtIndex = 0;
    const streamAssistantOutputItems: any[] = [];
    const streamAssistantMessage: Message = { role: 'assistant', content: null };
    const streamResponseOutput: any[] = [];
    let streamAssistantItemId = `msg_${uuidv4().replace(/-/g, '')}`;
    let streamAssistantItemAdded = false;
    let streamContentPartAdded = false;
    let streamStopAfterToolCall = false;

    const streamBuildUsage = () => ({
      input_tokens: streamPromptTokens,
      output_tokens: streamCompletionTokens,
      total_tokens: streamPromptTokens + streamCompletionTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    try {
      while (true) {
        const { done, value } = await readQwenChunk(reader);
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr) as QwenChunk;

            if (chunk['response.created']?.response_id && !streamTargetResponseId) {
              streamTargetResponseId = chunk['response.created'].response_id;
              streamState.targetResponseId = streamTargetResponseId;
              updateSessionParent(qwen.uiSessionId, streamTargetResponseId);
            } else if (chunk.response_id && !streamTargetResponseId) {
              streamTargetResponseId = chunk.response_id;
              streamState.targetResponseId = streamTargetResponseId;
              updateSessionParent(qwen.uiSessionId, streamTargetResponseId);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) streamCompletionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) streamPromptTokens = chunk.usage.input_tokens;
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta || (streamTargetResponseId && chunk.response_id && chunk.response_id !== streamTargetResponseId)) continue;

            if (delta.phase === 'thinking_summary' && delta.extra?.summary_thought?.content) {
              const thoughts = delta.extra.summary_thought.content;
              if (thoughts.length > streamCurrentThoughtIndex) {
                const thoughtDelta = thoughts.slice(streamCurrentThoughtIndex).join('\n');
                streamCurrentThoughtIndex = thoughts.length;
                streamReasoningBuffer += thoughtDelta;
                const parsed = toolParser.feed(thoughtDelta);
                for (const tc of parsed.toolCalls) {
                  const toolItem = responseItemFromToolCall(tc);
                  writeToolCallEvents(
                    controller,
                    responseId,
                    streamResponseOutput.length + streamAssistantOutputItems.length + 1,
                    toolItem,
                    writeEvent
                  );
                  streamAssistantOutputItems.push(toolItem);
                  debugTrace.toolCall(toolItem);
                  streamStopAfterToolCall = true;
                }
              }
            } else if (delta.phase === 'answer' && delta.content !== undefined) {
              const result = getIncrementalDelta(streamAssistantText, delta.content || '');
              if (result.delta) {
                const parsed = toolParser.feed(result.delta);
                if (parsed.text && !streamAssistantItemAdded) {
                  streamAssistantItemAdded = true;
                  writeEvent(controller, 'response.output_item.added', {
                    response_id: responseId,
                    output_index: streamResponseOutput.length,
                    item: {
                      type: 'message',
                      id: streamAssistantItemId,
                      role: 'assistant',
                      status: 'in_progress',
                      content: [],
                    },
                  });
                }

                if (parsed.text) {
                  if (!streamContentPartAdded) {
                    streamContentPartAdded = true;
                    writeEvent(controller, 'response.content_part.added', {
                      response_id: responseId,
                      item_id: streamAssistantItemId,
                      output_index: streamResponseOutput.length,
                      content_index: 0,
                      part: {
                        type: 'output_text',
                        text: '',
                        annotations: [],
                      },
                    });
                  }
                  streamAssistantText += parsed.text;
                  debugTrace.streamDelta('answer', parsed.text);
                  writeEvent(controller, 'response.output_text.delta', {
                    response_id: responseId,
                    item_id: streamAssistantItemId,
                    output_index: streamResponseOutput.length,
                    content_index: 0,
                    delta: parsed.text,
                  });
                }

                for (const tc of parsed.toolCalls) {
                  const toolItem = responseItemFromToolCall(tc);
                  writeToolCallEvents(
                    controller,
                    responseId,
                    streamResponseOutput.length + streamAssistantOutputItems.length + 1,
                    toolItem,
                    writeEvent
                  );
                  streamAssistantOutputItems.push(toolItem);
                  debugTrace.toolCall(toolItem);
                  streamStopAfterToolCall = true;
                }
              }
            }
          } catch {}
          if (streamStopAfterToolCall) break;
        }
        if (streamStopAfterToolCall) break;
      }

      if (streamStopAfterToolCall) {
        await stopQwenStreamIfKnown(qwen, streamTargetResponseId);
        await reader.cancel().catch(() => {});
      }

      const upstreamError = streamStopAfterToolCall ? null : parseQwenErrorPayload(streamBuffer);
      if (upstreamError) {
        debugTrace.failed(upstreamError.message);
        writeEvent(controller, 'response.completed', {
          response_id: responseId,
          response: {
            id: responseId,
            status: 'failed',
            error: {
              message: upstreamError.message,
              type: upstreamError.status >= 500 ? 'server_error' : 'invalid_request_error',
              code: upstreamError.status === 429 ? 'rate_limited' : 'upstream_error',
              param: null,
            },
          },
        });
        writeDone(controller);
        closeStream(controller);
        return;
      }

      const flush = toolParser.flush();
      if (flush.text) {
        if (!streamAssistantItemAdded) {
          streamAssistantItemAdded = true;
          writeEvent(controller, 'response.output_item.added', {
            response_id: responseId,
            output_index: 0,
            item: {
              type: 'message',
              id: streamAssistantItemId,
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
        }
        if (!streamContentPartAdded) {
          streamContentPartAdded = true;
          writeEvent(controller, 'response.content_part.added', {
            response_id: responseId,
            item_id: streamAssistantItemId,
            output_index: 0,
            content_index: 0,
            part: {
              type: 'output_text',
              text: '',
              annotations: [],
            },
          });
        }
        writeEvent(controller, 'response.output_text.delta', {
          response_id: responseId,
          item_id: streamAssistantItemId,
          output_index: 0,
          content_index: 0,
          delta: flush.text,
        });
        streamAssistantText += flush.text;
        debugTrace.streamDelta('answer', flush.text);
      }
      for (const tc of flush.toolCalls) {
        const toolItem = responseItemFromToolCall(tc);
        writeToolCallEvents(
          controller,
          responseId,
          (streamAssistantItemAdded ? 1 : 0) + streamAssistantOutputItems.length,
          toolItem,
          writeEvent
        );
        streamAssistantOutputItems.push(toolItem);
        debugTrace.toolCall(toolItem);
      }

      if (streamAssistantItemAdded) {
        writeEvent(controller, 'response.output_text.done', {
          response_id: responseId,
          item_id: streamAssistantItemId,
          output_index: 0,
          content_index: 0,
          text: streamAssistantText,
        });
        writeEvent(controller, 'response.content_part.done', {
          response_id: responseId,
          item_id: streamAssistantItemId,
          output_index: 0,
          content_index: 0,
          part: {
            type: 'output_text',
            text: streamAssistantText,
            annotations: [],
          },
        });
        writeEvent(controller, 'response.output_item.done', {
          response_id: responseId,
          output_index: 0,
          item: {
            type: 'message',
            id: streamAssistantItemId,
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: streamAssistantText,
              annotations: [],
            }],
          },
        });
      }

      const response = buildResponseEnvelope({
        id: responseId,
        createdAt: startedAt,
        model: body.model,
        body,
        previousResponseId,
        output: [
          ...(streamAssistantItemAdded ? [{
            type: 'message',
            id: streamAssistantItemId,
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: streamAssistantText,
              annotations: [],
            }],
          }] : []),
          ...streamAssistantOutputItems,
        ],
        outputText: streamAssistantText,
        usage: streamBuildUsage(),
      });

      writeEvent(controller, 'response.completed', {
        response_id: responseId,
        response,
      });
      writeDone(controller);
      closeStream(controller);
      debugTrace.completed({
        outputText: streamAssistantText,
        toolCalls: streamAssistantOutputItems,
        usage: streamBuildUsage(),
        status: response.status,
      });

      if (body.store ?? true) {
        storeResponseContext(responseId, [
          ...inputMessages,
          assistantContextMessage(streamAssistantText, streamAssistantOutputItems),
        ], sessionKey);
        pruneResponseContexts();
      }
      removeStream(responseId);
    } catch (err: any) {
      await reader.cancel().catch(() => {});
      if (isAbortError(err)) {
        const cancelledResponse = buildResponseEnvelope({
          id: responseId,
          createdAt: startedAt,
          model: body.model,
          body,
          previousResponseId,
          output: [],
          outputText: '',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          status: 'cancelled',
        });

        if (!streamState.cancelled) {
          writeEvent(controller, 'response.completed', {
            response_id: responseId,
            response: cancelledResponse,
          });
          writeDone(controller);
          closeStream(controller);
        }
        removeStream(responseId);
        return;
      }

      if (isStreamClosedError(err) || streamState.cancelled) {
        removeStream(responseId);
        return;
      }

      const error = responseErrorPayload(err);
      debugTrace.failed(error.message);
      console.error(`[Responses] Stream ${responseId} failed: ${error.code}: ${error.message}`);
      const failedResponse = buildResponseEnvelope({
        id: responseId,
        createdAt: startedAt,
        model: body.model,
        body,
        previousResponseId,
        output: [],
        outputText: '',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        status: 'failed',
        error,
      });
      writeEvent(controller, 'response.completed', {
        response_id: responseId,
        response: failedResponse,
      });
      writeDone(controller);
      closeStream(controller);
      removeStream(responseId);
    }
  };

  if (!stream) {
    const qwen = await acquireQwenStream(finalPrompt, body.model, responseId);
    const reader = qwen.stream.getReader();
    const decoder = new TextDecoder();
    const toolParser = new StreamingToolParser(toolDefinitionsForParser(body.tools));
    let stopAfterToolCall = false;
    try {
      while (true) {
        const { done, value } = await readQwenChunk(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr) as QwenChunk;
            if (chunk['response.created']?.response_id && !targetResponseId) {
              targetResponseId = chunk['response.created'].response_id;
              updateSessionParent(qwen.uiSessionId, targetResponseId);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              updateSessionParent(qwen.uiSessionId, targetResponseId);
            }
            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            const delta = chunk.choices?.[0]?.delta;
            if (!delta || (targetResponseId && chunk.response_id && chunk.response_id !== targetResponseId)) continue;

            if (delta.phase === 'thinking_summary' && delta.extra?.summary_thought?.content) {
              const thoughts = delta.extra.summary_thought.content;
              if (thoughts.length > currentThoughtIndex) {
                const thoughtDelta = thoughts.slice(currentThoughtIndex).join('\n');
                reasoningBuffer += thoughtDelta;
                currentThoughtIndex = thoughts.length;
                const parsed = toolParser.feed(thoughtDelta);
                for (const tc of parsed.toolCalls) {
                  const toolItem = responseItemFromToolCall(tc);
                  assistantOutputItems.push(toolItem);
                  debugTrace.toolCall(toolItem);
                  stopAfterToolCall = true;
                }
              }
            } else if (delta.phase === 'answer' && delta.content !== undefined) {
              const result = getIncrementalDelta(assistantText, delta.content || '');
              if (result.delta) {
                const parsed = toolParser.feed(result.delta);
                if (parsed.text) assistantText += parsed.text;
                for (const tc of parsed.toolCalls) {
                  const toolItem = responseItemFromToolCall(tc);
                  assistantOutputItems.push(toolItem);
                  debugTrace.toolCall(toolItem);
                  stopAfterToolCall = true;
                }
                if (parsed.text) {
                  assistantMessage.content = (assistantMessage.content || '') + parsed.text;
                }
              }
            }
          } catch {}
          if (stopAfterToolCall) break;
        }
        if (stopAfterToolCall) break;
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    if (stopAfterToolCall) {
      await stopQwenStreamIfKnown(qwen, targetResponseId);
      await reader.cancel().catch(() => {});
    }

    const upstreamError = stopAfterToolCall ? null : parseQwenErrorPayload(buffer);
    if (upstreamError) {
      debugTrace.failed(upstreamError.message);
      return createJsonResponse(openAIErrorBody(upstreamError.message, upstreamError.status, {
        code: upstreamError.status === 429 ? 'rate_limited' : 'upstream_error',
      }), upstreamError.status);
    }

    const flush = toolParser.flush();
    if (flush.text) {
      assistantText += flush.text;
      assistantMessage.content = (assistantMessage.content || '') + flush.text;
    }
    for (const tc of flush.toolCalls) {
      const toolItem = responseItemFromToolCall(tc);
      assistantOutputItems.push(toolItem);
      debugTrace.toolCall(toolItem);
    }

    if (assistantText) {
      responseOutput.push({
        type: 'message',
        id: assistantItemId,
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: assistantText,
          annotations: [],
        }],
      });
    }
    responseOutput.push(...assistantOutputItems);

    assistantMessage.content = assistantText || null;
    if (assistantOutputItems.length > 0) {
      assistantMessage.tool_calls = assistantOutputItems
        .filter((item) => item?.type === 'function_call')
        .map(responseItemToMessageToolCall);
    }

    const response = buildResponseEnvelope({
      id: responseId,
      createdAt: startedAt,
      model: body.model,
      body,
      previousResponseId,
      output: responseOutput,
      outputText: assistantText,
      usage: buildUsage(),
    });

    if (body.store ?? true) {
      storeResponseContext(responseId, [...inputMessages, assistantMessage], sessionKey);
      pruneResponseContexts();
    }

    removeStream(responseId);
    debugTrace.completed({
      outputText: assistantText,
      toolCalls: assistantOutputItems,
      usage: buildUsage(),
      status: response.status,
    });
    return createJsonResponse(response);
  }

  const streamResponse = new ReadableStream({
    start(controller) {
      writeEvent(controller, 'response.created', {
        response_id: responseId,
        response: {
          id: responseId,
          object: 'response',
          created_at: startedAt,
          status: 'in_progress',
          model: body.model,
          output: [],
          previous_response_id: previousResponseId,
        },
      });

      void runStream(controller).catch((err: any) => {
        if (!isStreamClosedError(err) && !streamState.cancelled) {
          const error = responseErrorPayload(err);
          console.error(`[Responses] Stream ${responseId} failed before recovery: ${error.code}: ${error.message}`);
          try {
            const failedResponse = buildResponseEnvelope({
              id: responseId,
              createdAt: startedAt,
              model: body.model,
              body,
              previousResponseId,
              output: [],
              outputText: '',
              usage: {
                input_tokens: promptTokenEstimate,
                output_tokens: 0,
                total_tokens: promptTokenEstimate,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
              status: 'failed',
              error,
            });
            writeEvent(controller, 'response.completed', {
              response_id: responseId,
              response: failedResponse,
            });
            closeStream(controller);
          } catch (controllerErr: any) {
            if (!isStreamClosedError(controllerErr)) throw controllerErr;
          }
        }
        removeStream(responseId);
      });
    },
    cancel() {
      streamState.cancelled = true;
      streamState.closed = true;
      const reader = streamState.reader;
      const qwen = streamState.qwen;
      if (reader) {
        void reader.cancel().catch(() => {});
      }
      if (qwen) {
        void stopQwenStreamIfKnown(qwen, streamState.targetResponseId).finally(() => {
          removeStream(responseId);
        });
      } else {
        removeStream(responseId);
      }
    },
  });

  return new Response(streamResponse, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

// #==========# Public handlers
export async function chatResponses(c: Context) {
  try {
    const body = normalizeResponsesRequest(await parseJsonBody(c.req.raw)) as ResponsesRequestBody;
    const responseId = `resp-${uuidv4()}`;
    const response = await handleResponses(
      body,
      !!body.stream,
      responseId,
      detectClientName(c.req.header('user-agent'), c.req.header('x-qwenproxy-client'))
    );
    response.headers.set('X-QwenProxy-Debug-Id', responseId);
    return response;
  } catch (err: any) {
    const { status, body } = openAIErrorFrom(err);
    console.error(`[Responses] ${status} ${body.error.code || body.error.type}: ${body.error.message}`);
    return createJsonResponse(body, status);
  }
}

export async function responsesStop(c: Context) {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const responseId = c.req.param('response_id') || body.response_id || body.id;

    if (!responseId) {
      return c.json(openAIErrorBody('response_id is required', 400, {
        code: 'missing_required_parameter',
        param: 'response_id',
      }), 400);
    }

    const aborted = abortStream(responseId);
    removeStream(responseId);

    return createJsonResponse(buildMinimalCancelledResponse(responseId), aborted ? 200 : 404);
  } catch (err: any) {
    console.error('Error in responsesStop:', err);
    const { status, body } = openAIErrorFrom(err);
    return c.json(body, status as any);
  }
}
