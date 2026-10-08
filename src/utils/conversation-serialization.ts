import { wrapToolCallPayload } from '../tools/toolcall-tags.js';

export interface HistoricalToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface ConversationMedia {
  type: string;
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  file_url?: { url: string };
}

export interface ConversationMessage {
  role: string;
  content: unknown;
  tool_calls?: HistoricalToolCall[];
  name?: string;
  tool_call_id?: string;
  media?: ConversationMedia[];
}

export interface PreparedMessage extends ConversationMessage { content: string }
export interface SerializationOptions { resolveToolName?: (id: string) => string | undefined }

export class ConversationContextError extends Error {
  readonly upstreamStatus = 400;
  readonly upstreamCode = 'ContextWindowExceeded';
}

export function prepareConversationMessage(message: ConversationMessage): PreparedMessage {
  const text: string[] = [];
  const media: ConversationMedia[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && ['image_url', 'video_url', 'audio_url', 'file_url'].includes(part.type)) media.push(part);
      else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') text.push(part.text);
      else text.push(JSON.stringify(part) ?? '');
    }
  } else if (typeof content === 'string') text.push(content);
  else if (content != null) text.push(JSON.stringify(content));
  return { role: message.role, content: text.join('\n'), tool_calls: message.tool_calls, name: message.name,
    tool_call_id: message.tool_call_id, ...(media.length ? { media } : {}) };
}

function serializeToolCall(call: HistoricalToolCall): string {
  const value = call.function?.arguments;
  let args: string;
  if (typeof value === 'string') {
    try { JSON.parse(value); args = value; }
    catch { args = JSON.stringify(value); }
  } else args = JSON.stringify(value ?? {});
  const metadata = JSON.stringify({ id: call.id, type: call.type, name: call.function?.name });
  return wrapToolCallPayload(`${metadata === '{}' ? '{' : metadata.slice(0, -1) + ','}"arguments":${args}}`);
}

export function serializeConversationMessages(messages: PreparedMessage[], options: SerializationOptions = {}): string {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) if (call.id && call.function?.name) names.set(call.id, call.function.name);
  }
  const labels = new Map([['user', 'User'], ['assistant', 'Assistant'], ['system', 'System'], ['developer', 'Developer']]);
  return messages.map(message => {
    if (message.role === 'tool' || message.role === 'function') {
      const name = message.name || (message.tool_call_id ? names.get(message.tool_call_id) || options.resolveToolName?.(message.tool_call_id) : undefined) || 'tool';
      const role = message.role === 'tool' ? 'Tool Response' : 'Function Response';
      const reference = message.tool_call_id ? `[tool_call_id: ${JSON.stringify(message.tool_call_id)}]\n` : '';
      return `${role} (${name}): ${reference}${message.content}`;
    }
    const label = labels.get(message.role) || message.role;
    const named = message.name ? ` (${message.name})` : '';
    const calls = message.tool_calls?.map(serializeToolCall).join('\n');
    return `${label}${named}: ${message.content}${calls ? (message.content ? '\n' : '') + calls : ''}`;
  }).join('\n\n');
}
