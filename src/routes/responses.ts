/*
 * File: responses.ts
 * Project: qwenproxy
 * OpenAI Responses API compatibility adapter.
 */

import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';

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
};

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
        role,
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

function conversationId(body: ResponsesRequest): string | undefined {
  if (typeof body.conversation === 'string' && body.conversation.trim()) return body.conversation;
  if (body.conversation && typeof body.conversation === 'object' && body.conversation.id) return body.conversation.id;
  if (typeof body.previous_response_id === 'string' && body.previous_response_id.trim()) {
    return `resp_${body.previous_response_id}`;
  }
  return undefined;
}

function buildChatRequest(body: ResponsesRequest, stream: boolean) {
  const messages = responsesInputToMessages(body);
  const tools = responsesToolsToChatTools(body.tools);
  const chatId = conversationId(body);

  return {
    model: body.model,
    messages,
    stream,
    ...(tools ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(chatId ? { chat_id: chatId } : {})
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

  for (const toolCall of params.toolCalls) {
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
    const body = await c.req.json().catch(() => null) as ResponsesRequest | null;
    if (!body || !body.model) {
      return c.json({ error: { message: 'Malformed Responses API request' } }, 400);
    }

    const chatBody = buildChatRequest(body, !!body.stream);
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
        id: `resp_${uuidv4()}`,
        model: chatJson?.model || body.model,
        outputText: message.content || '',
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        usage: chatJson?.usage,
        request: body,
        status: 'completed'
      });

      return c.json(response);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async streamWriter => {
      const responseId = `resp_${uuidv4()}`;
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
          status: 'in_progress'
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
              const normalized = {
                id: toolCall.id || `call_${uuidv4()}`,
                type: 'function',
                function: {
                  name: toolCall.function?.name,
                  arguments: toolCall.function?.arguments || ''
                }
              };
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
      await emit('response.completed', {
        response: buildResponseObject({
          id: responseId,
          model,
          outputText,
          toolCalls,
          usage,
          request: body,
          status: 'completed'
        })
      });
    });
  };
}
