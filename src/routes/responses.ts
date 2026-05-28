/*
 * File: responses.ts
 * Project: qwenproxy
 * OpenAI Responses API compatibility adapter.
 */

import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import {
  deleteStoredResponse,
  getStoredResponse,
  saveStoredResponse,
  type StoredResponseRecord
} from '../storage/response-store.ts';

type ChatDispatch = (request: Request) => Promise<Response>;

type ResponseInputItem = {
  type?: string;
  role?: string;
  content?: any;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: any;
};

type ResponsesRequest = {
  model: string;
  input?: string | ResponseInputItem[];
  instructions?: string;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  previous_response_id?: string | null;
  conversation?: string | { id?: string } | null;
  metadata?: Record<string, unknown>;
  store?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  prompt_cache_key?: string;
  client_metadata?: Record<string, unknown>;
};

const DEFAULT_CODEX_TOOLS = [
  {
    type: 'function',
    name: 'exec_command',
    description: 'Run a shell command in the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        workdir: { type: 'string' },
        yield_time_ms: { type: 'number' },
        max_output_tokens: { type: 'number' }
      },
      required: ['cmd']
    }
  },
  {
    type: 'function',
    name: 'write_stdin',
    description: 'Send input to an existing command session and read recent output.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
        chars: { type: 'string' },
        yield_time_ms: { type: 'number' },
        max_output_tokens: { type: 'number' }
      },
      required: ['session_id']
    }
  },
  {
    type: 'function',
    name: 'apply_patch',
    description: 'Apply a source-code patch to files in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string' }
      },
      required: ['patch']
    }
  },
  {
    type: 'function',
    name: 'update_plan',
    description: 'Update the visible task plan.',
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['step', 'status']
          }
        }
      },
      required: ['plan']
    }
  },
  {
    type: 'function',
    name: 'view_image',
    description: 'Inspect a local image file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        detail: { type: 'string', enum: ['high', 'original'] }
      },
      required: ['path']
    }
  },
  {
    type: 'function',
    name: 'list_mcp_resources',
    description: 'List MCP resources available to the agent.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        cursor: { type: 'string' }
      }
    }
  },
  {
    type: 'function',
    name: 'list_mcp_resource_templates',
    description: 'List MCP resource templates available to the agent.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        cursor: { type: 'string' }
      }
    }
  },
  {
    type: 'function',
    name: 'read_mcp_resource',
    description: 'Read a specific MCP resource.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        uri: { type: 'string' }
      },
      required: ['server', 'uri']
    }
  },
  {
    type: 'function',
    name: 'get_goal',
    description: 'Get the current goal for this thread.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    type: 'function',
    name: 'create_goal',
    description: 'Create a goal when explicitly requested.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        token_budget: { type: 'number' }
      },
      required: ['objective']
    }
  },
  {
    type: 'function',
    name: 'update_goal',
    description: 'Mark the existing goal complete or blocked.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['complete', 'blocked'] }
      },
      required: ['status']
    }
  },
  {
    type: 'function',
    name: 'request_user_input',
    description: 'Request structured user input when available in the active mode.',
    parameters: {
      type: 'object',
      properties: {
        questions: { type: 'array', items: { type: 'object' } }
      },
      required: ['questions']
    }
  },
  {
    type: 'function',
    name: 'multi_tool_use.parallel',
    description: 'Run multiple tool calls in parallel.',
    parameters: {
      type: 'object',
      properties: {
        tool_uses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              recipient_name: { type: 'string' },
              parameters: { type: 'object' }
            },
            required: ['recipient_name', 'parameters']
          }
        }
      },
      required: ['tool_uses']
    }
  }
];

function withDefaultCodexTools(body: ResponsesRequest): ResponsesRequest {
  if (Array.isArray(body.tools) && body.tools.length > 0) return body;
  const haystack = JSON.stringify({
    instructions: body.instructions || '',
    input: body.input || ''
  }).toLowerCase();
  const looksLikeCodex =
    haystack.includes('codex') ||
    haystack.includes('functions.') ||
    haystack.includes('multi_tool_use') ||
    haystack.includes('exec_command') ||
    haystack.includes('apply_patch');
  if (!looksLikeCodex) return body;
  return { ...body, tools: DEFAULT_CODEX_TOOLS };
}

function textFromContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return String(part);
    if (typeof part.text === 'string') return part.text;
    if (typeof part.output_text === 'string') return part.output_text;
    if (typeof part.input_text === 'string') return part.input_text;
    return JSON.stringify(part);
  }).join('\n');
}

function responsesInputToMessages(body: ResponsesRequest): any[] {
  const messages: any[] = [];

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }

  if (!Array.isArray(body.input)) {
    return messages;
  }

  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        name: item.name,
        content: textFromContent(item.output)
      });
      continue;
    }

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || `call_${uuidv4()}`,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
          }
        }]
      });
      continue;
    }

    const role = item.role || (item.type === 'message' ? 'user' : null);
    if (role) {
      messages.push({
        role: role === 'developer' ? 'system' : role,
        content: textFromContent(item.content)
      });
    }
  }

  return messages;
}

function responsesToolsToChatTools(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  return tools
    .filter(tool => tool && (tool.type === 'function' || tool.function))
    .map(tool => {
      if (tool.function) return tool;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {}
        }
      };
    });
}

function toolName(tool: any): string {
  return tool?.name || tool?.function?.name || '';
}

function availableToolNames(tools: any[] | undefined): Set<string> {
  return new Set((tools || []).map(toolName).filter(Boolean));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeToolCallForRuntime(toolCall: any, request: ResponsesRequest): any {
  const names = availableToolNames(request.tools);
  const name = toolCall.function?.name || toolCall.name;
  const rawArguments = toolCall.function?.arguments || toolCall.arguments || '{}';

  if ((name === 'apply_patch' || name === 'functions.apply_patch') && !names.has(name) && names.has('exec_command')) {
    let patch = '';
    try {
      const parsed = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
      patch = typeof parsed?.patch === 'string'
        ? parsed.patch
        : typeof parsed?.command === 'string'
          ? parsed.command
          : '';
    } catch {
      patch = typeof rawArguments === 'string' ? rawArguments : '';
    }

    if (patch.trim()) {
      return {
        ...toolCall,
        type: 'function',
        function: {
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: `apply_patch ${shellQuote(patch)}` })
        }
      };
    }
  }

  return toolCall;
}

function conversationId(body: ResponsesRequest): string | undefined {
  if (typeof body.conversation === 'string' && body.conversation.trim()) return body.conversation;
  if (body.conversation && typeof body.conversation === 'object' && body.conversation.id) return body.conversation.id;
  return undefined;
}

async function resolveChatId(body: ResponsesRequest): Promise<{ chatId?: string; missingPreviousResponseId?: string; replaceHistory?: boolean }> {
  const explicitConversationId = conversationId(body);
  if (explicitConversationId) return { chatId: explicitConversationId };

  if (typeof body.previous_response_id === 'string' && body.previous_response_id.trim()) {
    const previous = await getStoredResponse(body.previous_response_id);
    if (!previous) return { missingPreviousResponseId: body.previous_response_id };
    return { chatId: previous.chatId };
  }

  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim()) {
    return { chatId: `resp_cache_${body.prompt_cache_key.trim()}`, replaceHistory: true };
  }

  return { chatId: `resp_chat_${uuidv4()}` };
}

function normalizeInputItems(input: ResponsesRequest['input']): unknown[] {
  if (typeof input === 'string') {
    return [{
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: input }]
    }];
  }
  return Array.isArray(input) ? input : [];
}

function buildChatRequest(body: ResponsesRequest, stream: boolean, chatId?: string, replaceHistory = false) {
  const messages = responsesInputToMessages(body);
  const tools = responsesToolsToChatTools(body.tools);

  return {
    model: body.model,
    messages,
    stream,
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(chatId ? { chat_id: chatId } : {}),
    ...(replaceHistory ? { history_policy: 'replace' } : {})
  };
}

function buildResponseObject(params: {
  id: string;
  model: string;
  outputText: string;
  toolCalls: any[];
  usage?: any;
  request: ResponsesRequest;
  status?: 'in_progress' | 'completed' | 'failed';
  chatId?: string;
}) {
  const createdAt = Math.floor(Date.now() / 1000);
  const output: any[] = [];

  if (params.outputText || params.toolCalls.length === 0) {
    output.push({
      id: `msg_${uuidv4()}`,
      type: 'message',
      status: params.status === 'completed' ? 'completed' : 'in_progress',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: params.outputText,
        annotations: []
      }]
    });
  }

  for (const originalToolCall of params.toolCalls) {
    const toolCall = normalizeToolCallForRuntime(originalToolCall, params.request);
    output.push({
      id: toolCall.id || `fc_${uuidv4()}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id || `call_${uuidv4()}`,
      name: toolCall.function?.name || toolCall.name,
      arguments: toolCall.function?.arguments || toolCall.arguments || '{}'
    });
  }

  const promptTokens = params.usage?.prompt_tokens || 0;
  const completionTokens = params.usage?.completion_tokens || 0;

  return {
    id: params.id,
    object: 'response',
    created_at: createdAt,
    status: params.status || 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: params.request.instructions || null,
    max_output_tokens: params.request.max_output_tokens || null,
    model: params.model,
    output,
    output_text: params.outputText,
    parallel_tool_calls: true,
    previous_response_id: params.request.previous_response_id || null,
    conversation: params.chatId ? { id: params.chatId } : null,
    store: params.request.store ?? true,
    temperature: params.request.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: params.request.tool_choice || 'auto',
    tools: params.request.tools || [],
    top_p: params.request.top_p ?? null,
    truncation: 'disabled',
    usage: {
      input_tokens: promptTokens,
      input_tokens_details: { cached_tokens: params.usage?.prompt_tokens_details?.cached_tokens || 0 },
      output_tokens: completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: params.usage?.total_tokens || promptTokens + completionTokens
    },
    metadata: params.request.metadata || {}
  };
}

async function persistResponse(params: {
  id: string;
  chatId: string;
  request: ResponsesRequest;
  response: unknown;
  inputItems: unknown[];
}): Promise<StoredResponseRecord> {
  const now = new Date().toISOString();
  return await saveStoredResponse({
    id: params.id,
    chatId: params.chatId,
    createdAt: now,
    updatedAt: now,
    request: params.request,
    response: params.response,
    inputItems: params.inputItems
  });
}

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSsePayloads(buffer: string): { payloads: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() || '';
  const payloads: string[] = [];

  for (const part of parts) {
    const dataLines = part
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6));
    if (dataLines.length) payloads.push(dataLines.join('\n'));
  }

  return { payloads, rest };
}

export function createResponsesHandler(dispatchChat: ChatDispatch) {
  return async function responsesHandler(c: Context) {
    const rawBody = await c.req.json().catch(() => null) as ResponsesRequest | null;
    if (!rawBody || !rawBody.model) {
      return c.json({ error: { message: 'Malformed Responses API request' } }, 400);
    }
    if (rawBody.previous_response_id && rawBody.conversation) {
      return c.json({
        error: {
          message: 'previous_response_id cannot be used together with conversation',
          type: 'invalid_request_error',
          param: 'previous_response_id'
        }
      }, 400);
    }
    const body = withDefaultCodexTools(rawBody);
    const { chatId, missingPreviousResponseId, replaceHistory } = await resolveChatId(body);
    if (missingPreviousResponseId) {
      return c.json({
        error: {
          message: `Unknown previous_response_id: ${missingPreviousResponseId}`,
          type: 'invalid_request_error',
          param: 'previous_response_id'
        }
      }, 404);
    }
    const inputItems = normalizeInputItems(rawBody.input);
    const responseId = `resp_${uuidv4()}`;

    const chatBody = buildChatRequest(body, !!body.stream, chatId, !!replaceHistory);
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');

    const chatRequest = new Request(new URL('/v1/chat/completions', c.req.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(chatBody)
    });

    const chatResponse = await dispatchChat(chatRequest);

    if (!body.stream) {
      const chatJson = await chatResponse.json().catch(() => null);
      if (!chatResponse.ok) {
        return c.json(chatJson || { error: { message: 'Chat completion failed' } }, chatResponse.status as any);
      }

      const message = chatJson?.choices?.[0]?.message || {};
      const response = buildResponseObject({
        id: responseId,
        model: chatJson?.model || body.model,
        outputText: message.content || '',
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        usage: chatJson?.usage,
        request: body,
        status: 'completed',
        chatId
      });
      if (chatId) {
        await persistResponse({ id: response.id, chatId, request: body, response, inputItems });
      }

      return c.json(response);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async streamWriter => {
      const messageItemId = `msg_${uuidv4()}`;
      let sequence = 0;
      let outputText = '';
      let model = body.model;
      let usage: any = undefined;
      const toolCalls: any[] = [];

      const emit = async (type: string, data: Record<string, unknown>) => {
        sequence++;
        await streamWriter.write(sse(type, { type, sequence_number: sequence, ...data }));
      };

      await emit('response.created', {
        response: buildResponseObject({
          id: responseId,
          model,
          outputText: '',
          toolCalls: [],
          request: body,
          status: 'in_progress',
          chatId
        })
      });

      await emit('response.output_item.added', {
        output_index: 0,
        item: {
          id: messageItemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: []
        }
      });

      await emit('response.content_part.added', {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      });

      const reader = chatResponse.body?.getReader();
      if (!reader) {
        await emit('response.failed', {
          response: {
            id: responseId,
            object: 'response',
            status: 'failed',
            error: { message: 'Chat completion stream was empty' }
          }
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSsePayloads(buffer);
        buffer = parsed.rest;

        for (const payload of parsed.payloads) {
          if (payload === '[DONE]') continue;

          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          model = chunk.model || model;
          if (chunk.usage) usage = chunk.usage;

          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};

          if (typeof delta.content === 'string' && delta.content) {
            outputText += delta.content;
            await emit('response.output_text.delta', {
              item_id: messageItemId,
              output_index: 0,
              content_index: 0,
              delta: delta.content
            });
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const toolCall of delta.tool_calls) {
              const normalized = normalizeToolCallForRuntime({
                id: toolCall.id || `call_${uuidv4()}`,
                type: 'function',
                function: {
                  name: toolCall.function?.name,
                  arguments: toolCall.function?.arguments || ''
                }
              }, body);
              toolCalls.push(normalized);
              await emit('response.output_item.added', {
                output_index: toolCalls.length,
                item: {
                  id: normalized.id,
                  type: 'function_call',
                  status: 'in_progress',
                  call_id: normalized.id,
                  name: normalized.function.name,
                  arguments: ''
                }
              });
              await emit('response.function_call_arguments.delta', {
                item_id: normalized.id,
                output_index: toolCalls.length,
                delta: normalized.function.arguments
              });
              await emit('response.function_call_arguments.done', {
                item_id: normalized.id,
                output_index: toolCalls.length,
                arguments: normalized.function.arguments
              });
              await emit('response.output_item.done', {
                output_index: toolCalls.length,
                item: {
                  id: normalized.id,
                  type: 'function_call',
                  status: 'completed',
                  call_id: normalized.id,
                  name: normalized.function.name,
                  arguments: normalized.function.arguments
                }
              });
            }
          }
        }
      }

      await emit('response.output_text.done', {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        text: outputText
      });
      await emit('response.content_part.done', {
        item_id: messageItemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: outputText, annotations: [] }
      });
      await emit('response.output_item.done', {
        output_index: 0,
        item: {
          id: messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText, annotations: [] }]
        }
      });
      const response = buildResponseObject({
        id: responseId,
        model,
        outputText,
        toolCalls,
        usage,
        request: body,
        status: 'completed',
        chatId
      });
      await emit('response.completed', {
        response
      });
      if (chatId) {
        await persistResponse({
          id: responseId,
          chatId,
          request: body,
          response,
          inputItems
        });
      }
    });
  };
}

export async function getResponseHandler(c: Context) {
  const responseId = c.req.param('responseId');
  if (!responseId) return c.json({ error: { message: 'Missing response id' } }, 400);
  const stored = await getStoredResponse(responseId);
  if (!stored) {
    return c.json({ error: { message: `Response not found: ${responseId}` } }, 404);
  }
  return c.json(stored.response);
}

export async function deleteResponseHandler(c: Context) {
  const responseId = c.req.param('responseId');
  if (!responseId) return c.json({ error: { message: 'Missing response id' } }, 400);
  const deleted = await deleteStoredResponse(responseId);
  if (!deleted) {
    return c.json({ error: { message: `Response not found: ${responseId}` } }, 404);
  }
  return c.json({ id: responseId, object: 'response.deleted', deleted: true });
}

export async function listResponseInputItemsHandler(c: Context) {
  const responseId = c.req.param('responseId');
  if (!responseId) return c.json({ error: { message: 'Missing response id' } }, 400);
  const stored = await getStoredResponse(responseId);
  if (!stored) {
    return c.json({ error: { message: `Response not found: ${responseId}` } }, 404);
  }
  const data = stored.inputItems;
  return c.json({
    object: 'list',
    data,
    first_id: (data[0] as any)?.id || null,
    last_id: (data[data.length - 1] as any)?.id || null,
    has_more: false
  });
}
