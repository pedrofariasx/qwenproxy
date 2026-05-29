/*
 * #==========# Responses route
 * OpenAI Responses-style adapter with live SSE passthrough to Qwen.
 * Keeps the proxy isolated from completions internals.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'hono';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import type { Message, OpenAIRequest, FunctionToolDefinition } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { getIncrementalDelta } from './chat.ts';
import { getModelContextWindow } from '../core/model-registry.js';
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, abortStream } from '../core/stream-registry.ts';
import { Mutex } from '../services/playwright.ts';
import { getResponseContext, pruneResponseContexts, storeResponseContext } from '../core/response-store.ts';

type ResponsesInputItem = string | Record<string, any>;

interface ResponsesRequestBody {
  model: string;
  input?: ResponsesInputItem | ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string;
  stream?: boolean;
  store?: boolean;
  tools?: FunctionToolDefinition[];
  tool_choice?: OpenAIRequest['tool_choice'];
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
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function eventPayload(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function normalizeContentPart(part: any): string {
  if (part == null) return '';
  if (typeof part === 'string') return part;
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

    if (item.type === 'function_call') {
      return [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.id || item.call_id || `call_${uuidv4()}`,
          type: 'function',
          function: {
            name: item.name || item.function?.name || 'tool',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
          },
        }],
      }];
    }

    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      return [{
        role: 'tool',
        content: normalizeContentPart(item.output ?? item.content ?? ''),
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

  const formattedTools = body.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters,
      };
    }
    return t;
  });

  const toolsJson = JSON.stringify(formattedTools, null, 2);
  let next = `${systemPrompt}\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text after your <tool_call> blocks.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n`;

  if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.function) {
    next += `\nCRITICAL: You MUST call the tool "${body.tool_choice.function.name}" in this response.\n`;
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
}) {
  return {
    id: params.id,
    object: 'response',
    created_at: params.createdAt,
    status: params.status ?? 'completed',
    error: null,
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
      console.log(`[Responses] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
      account = getNextAvailableAccount(accountId);
      continue;
    }

    console.log(`[Responses] Routing request to account: ${accountEmail} (${accountId})`);

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
            undefined,
            accountId === 'global' ? undefined : accountId
          );
          registerStream(streamKey, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
          });
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

async function handleResponses(body: ResponsesRequestBody, stream: boolean, responseId: string): Promise<Response> {
  const previousResponseId = body.previous_response_id ?? null;
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

  const qwen = await acquireQwenStream(finalPrompt, body.model, responseId);
  const reader = qwen.stream.getReader();
  const decoder = new TextDecoder();
  const toolParser = new StreamingToolParser(body.tools || []);

  const startedAt = Math.floor(Date.now() / 1000);
  const assistantOutputItems: any[] = [];
  let assistantText = '';
  let reasoningBuffer = '';
  let currentThoughtIndex = 0;
  let buffer = '';
  let completionTokens = 0;
  let promptTokens = Math.ceil(finalPrompt.length / 3.5);
  let targetResponseId: string | null = null;

  const assistantMessage: Message = { role: 'assistant', content: null };
  const responseOutput: any[] = [];
  let assistantItemId = `msg_${uuidv4().replace(/-/g, '')}`;
  let assistantItemAdded = false;

  const writeEvent = (controller: ReadableStreamDefaultController, event: string, payload: unknown) => {
    controller.enqueue(new TextEncoder().encode(eventPayload(event, payload)));
  };

  const buildUsage = () => ({
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });

  if (!stream) {
    while (true) {
      const { done, value } = await reader.read();
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
              reasoningBuffer += thoughts.slice(currentThoughtIndex).join('\n');
              currentThoughtIndex = thoughts.length;
            }
          } else if (delta.phase === 'answer' && delta.content !== undefined) {
            const result = getIncrementalDelta(assistantText, delta.content || '');
            if (result.delta) {
              const parsed = toolParser.feed(result.delta);
              if (parsed.text) assistantText += parsed.text;
              for (const tc of parsed.toolCalls) {
                assistantOutputItems.push({
                  type: 'function_call',
                  id: tc.id,
                  call_id: tc.id,
                  status: 'completed',
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                });
              }
              if (parsed.text) {
                assistantMessage.content = (assistantMessage.content || '') + parsed.text;
              }
            }
          }
        } catch {}
      }
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      return createJsonResponse({ error: { message: upstreamError.message } }, upstreamError.status);
    }

    const flush = toolParser.flush();
    if (flush.text) {
      assistantText += flush.text;
      assistantMessage.content = (assistantMessage.content || '') + flush.text;
    }
    for (const tc of flush.toolCalls) {
      assistantOutputItems.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        status: 'completed',
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      });
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
      storeResponseContext(responseId, [...inputMessages, assistantMessage]);
      pruneResponseContexts();
    }

    removeStream(responseId);
    return createJsonResponse(response);
  }

  const streamResponse = new ReadableStream({
    async start(controller) {
      try {
        writeEvent(controller, 'response.created', {
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

        while (true) {
          const { done, value } = await reader.read();
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
                  currentThoughtIndex = thoughts.length;
                  reasoningBuffer += thoughtDelta;
                }
          } else if (delta.phase === 'answer' && delta.content !== undefined) {
            const result = getIncrementalDelta(assistantText, delta.content || '');
            if (result.delta) {
                  const parsed = toolParser.feed(result.delta);
                  if (parsed.text && !assistantItemAdded) {
                    assistantItemAdded = true;
                    writeEvent(controller, 'response.output_item.added', {
                      response_id: responseId,
                      output_index: responseOutput.length,
                      item: {
                        type: 'message',
                        id: assistantItemId,
                        role: 'assistant',
                        status: 'in_progress',
                        content: [],
                      },
                    });
                  }

                  if (parsed.text) {
                    assistantText += parsed.text;
                    writeEvent(controller, 'response.output_text.delta', {
                      response_id: responseId,
                      output_index: responseOutput.length,
                      content_index: 0,
                      delta: parsed.text,
                    });
                  }

                  for (const tc of parsed.toolCalls) {
                    const toolItem = {
                      type: 'function_call',
                      id: tc.id,
                      call_id: tc.id,
                      status: 'in_progress',
                      name: tc.name,
                      arguments: '',
                    };
                    writeEvent(controller, 'response.output_item.added', {
                      response_id: responseId,
                      output_index: responseOutput.length + 1,
                      item: toolItem,
                    });
                    const argumentsText = JSON.stringify(tc.arguments);
                    writeEvent(controller, 'response.function_call_arguments.delta', {
                      response_id: responseId,
                      item_id: tc.id,
                      output_index: responseOutput.length + 1,
                      content_index: 0,
                      delta: argumentsText,
                    });
                    writeEvent(controller, 'response.function_call_arguments.done', {
                      response_id: responseId,
                      item_id: tc.id,
                      output_index: responseOutput.length + 1,
                      content_index: 0,
                      arguments: argumentsText,
                    });
                    writeEvent(controller, 'response.output_item.done', {
                      response_id: responseId,
                      output_index: responseOutput.length + 1,
                      item: { ...toolItem, status: 'completed', arguments: argumentsText },
                    });
                    assistantOutputItems.push({
                      type: 'function_call',
                      id: tc.id,
                      call_id: tc.id,
                      status: 'completed',
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    });
                  }
                }
              }
            } catch {}
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          writeEvent(controller, 'response.completed', {
            response: {
              id: responseId,
              status: 'failed',
              error: upstreamError.message,
            },
          });
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        const flush = toolParser.flush();
        if (flush.text) {
          if (!assistantItemAdded) {
            assistantItemAdded = true;
            writeEvent(controller, 'response.output_item.added', {
              response_id: responseId,
              output_index: 0,
              item: {
                type: 'message',
                id: assistantItemId,
                role: 'assistant',
                status: 'in_progress',
                content: [],
              },
            });
          }
          writeEvent(controller, 'response.output_text.delta', {
            response_id: responseId,
            output_index: 0,
            content_index: 0,
            delta: flush.text,
          });
          assistantText += flush.text;
        }
        for (const tc of flush.toolCalls) {
          const toolItem = {
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            status: 'in_progress',
            name: tc.name,
            arguments: '',
          };
          writeEvent(controller, 'response.output_item.added', {
            response_id: responseId,
            output_index: 1,
            item: toolItem,
          });
          const argumentsText = JSON.stringify(tc.arguments);
          writeEvent(controller, 'response.function_call_arguments.delta', {
            response_id: responseId,
            item_id: tc.id,
            output_index: 1,
            content_index: 0,
            delta: argumentsText,
          });
          writeEvent(controller, 'response.function_call_arguments.done', {
            response_id: responseId,
            item_id: tc.id,
            output_index: 1,
            content_index: 0,
            arguments: argumentsText,
          });
          writeEvent(controller, 'response.output_item.done', {
            response_id: responseId,
            output_index: 1,
            item: { ...toolItem, status: 'completed', arguments: argumentsText },
          });
          assistantOutputItems.push({
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            status: 'completed',
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }

        if (assistantItemAdded) {
          writeEvent(controller, 'response.output_text.done', {
            response_id: responseId,
            output_index: 0,
            content_index: 0,
            text: assistantText,
          });
          writeEvent(controller, 'response.content_part.done', {
            response_id: responseId,
            output_index: 0,
            content_index: 0,
            part: {
              type: 'output_text',
              text: assistantText,
              annotations: [],
            },
          });
          writeEvent(controller, 'response.output_item.done', {
            response_id: responseId,
            output_index: 0,
            item: {
              type: 'message',
              id: assistantItemId,
              role: 'assistant',
              status: 'completed',
              content: [{
                type: 'output_text',
                text: assistantText,
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
            ...(assistantItemAdded ? [{
              type: 'message',
              id: assistantItemId,
              role: 'assistant',
              status: 'completed',
              content: [{
                type: 'output_text',
                text: assistantText,
                annotations: [],
              }],
            }] : []),
            ...assistantOutputItems,
          ],
          outputText: assistantText,
          usage: buildUsage(),
        });

        writeEvent(controller, 'response.completed', { response });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();

        if (body.store ?? true) {
          storeResponseContext(responseId, [...inputMessages, { role: 'assistant', content: assistantText }]);
          pruneResponseContexts();
        }
        removeStream(responseId);
      } catch (err: any) {
        if (isAbortError(err)) {
          const cancelledResponse = buildResponseEnvelope({
            id: responseId,
            createdAt: startedAt,
            model: body.model,
            body,
            previousResponseId,
            output: [],
            outputText: assistantText,
            usage: buildUsage(),
            status: 'cancelled',
          });

          writeEvent(controller, 'response.completed', { response: cancelledResponse });
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
          removeStream(responseId);
          return;
        }

        console.error('Error streaming responses:', err);
        controller.error(err);
        removeStream(responseId);
      }
    },
  });

  return new Response(streamResponse, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}

// #==========# Public handlers
export async function chatResponses(c: Context) {
  try {
    const body = await c.req.json() as ResponsesRequestBody;
    const responseId = `resp-${uuidv4()}`;
    return await handleResponses(body, !!body.stream, responseId);
  } catch (err: any) {
    console.error('Error in chatResponses:', err);
    const status = err.upstreamStatus || 500;
    return createJsonResponse({ error: { message: err.message } }, status);
  }
}

export async function responsesStop(c: Context) {
  try {
    const body = await c.req.json().catch(() => ({} as any));
    const responseId = c.req.param('response_id') || body.response_id || body.id;

    if (!responseId) {
      return c.json({ error: 'response_id is required' }, 400);
    }

    const aborted = abortStream(responseId);
    removeStream(responseId);

    return createJsonResponse(buildMinimalCancelledResponse(responseId), aborted ? 200 : 404);
  } catch (err: any) {
    console.error('Error in responsesStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
