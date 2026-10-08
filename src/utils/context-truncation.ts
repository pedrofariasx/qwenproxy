import { getModelTokenDivisor } from '../core/model-registry.js'
import { countTokens } from '../core/tokenizer.js'

import { prepareConversationMessage, serializeConversationMessages, ConversationContextError, type ConversationMessage, type PreparedMessage, type SerializationOptions } from './conversation-serialization.js';

export type TruncatedMessage = PreparedMessage;

export function estimateTokenCount(text: string, modelId?: string): number {
  const divisor = getModelTokenDivisor(modelId)
  return countTokens(text, divisor)
}

function truncateSemantically(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  
  const truncated = content.slice(0, maxChars);
  
  if (truncated.trimStart().startsWith('{') || truncated.trimStart().startsWith('[')) {
    const lastBrace = Math.max(truncated.lastIndexOf('}'), truncated.lastIndexOf(']'));
    if (lastBrace > maxChars * 0.7) {
      return truncated.slice(0, lastBrace + 1) + ' /* truncated */';
    }
  }
  
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.8) {
    return truncated.slice(0, lastNewline) + '\n[Truncated]';
  }
  
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.9) {
    return truncated.slice(0, lastSpace) + '... [Truncated]';
  }
  
  return truncated + '... [Truncated]';
}

const TOOL_MEMORY_MAX_ITEMS = 24;
const TOOL_MEMORY_ITEM_MAX_CHARS = 180;

function summarizeContent(content: string, maxChars = TOOL_MEMORY_ITEM_MAX_CHARS): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}... [truncated]`;
}

function stringifyToolArgs(args: unknown): string {
  if (typeof args === 'string') return summarizeContent(args, 220);
  try {
    return summarizeContent(JSON.stringify(args), 220);
  } catch {
    return summarizeContent(String(args), 220);
  }
}

function buildToolMemory(messages: Array<{ role: string; content: string | null | any[] | Record<string, unknown>; tool_calls?: any[]; name?: string; tool_call_id?: string }>, cutoffIndex: number): string {
  const lines: string[] = [];

  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = call?.function?.name || call?.name || 'unknown_tool';
        const args: unknown = call?.function?.arguments ?? {};
        lines.push(`- call ${call.id || 'unknown'}: ${name}(${stringifyToolArgs(args)})`);
        if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join('\n');
      }
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      const contentStr = Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : typeof msg.content === 'object' && msg.content !== null
          ? JSON.stringify(msg.content)
          : msg.content || '';
      const toolName = msg.name || msg.tool_call_id || 'tool';
      lines.push(`- ${toolName} response: ${summarizeContent(contentStr)}`);
      if (lines.length >= TOOL_MEMORY_MAX_ITEMS) return lines.join('\n');
    }
  }

  return lines.join('\n');
}

interface MessageGroup {
  messages: PreparedMessage[];
  totalTokens: number;
  endIndex: number;
  atomic: boolean;
}

function buildAtomicGroups(normalized: PreparedMessage[], modelId?: string, options?: SerializationOptions): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const message = normalized[i];
    const messages = [message];
    if (message.tool_calls?.length || message.role === 'tool' || message.role === 'function') {
      while (i + 1 < normalized.length && ['tool', 'function'].includes(normalized[i + 1].role)) messages.push(normalized[++i]);
    }
    groups.push({ messages, endIndex: i, totalTokens: estimateTokenCount(serializeConversationMessages(messages, options), modelId),
      atomic: messages.some(item => item.tool_calls?.length || item.media?.length || item.role === 'tool' || item.role === 'function') });
  }
  return groups;
}

function fitPlainMessage(message: PreparedMessage, budget: number, modelId?: string, options?: SerializationOptions): PreparedMessage | undefined {
  let low = 0;
  let high = message.content.length;
  let best: PreparedMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...message, content: `[Truncated] ${truncateSemantically(message.content, middle)}` };
    if (estimateTokenCount(serializeConversationMessages([candidate], options), modelId) <= budget) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

export function truncateMessages(
  messages: ConversationMessage[],
  maxContextLength: number,
  systemPrompt = '',
  modelId?: string,
  options?: SerializationOptions,
): TruncatedMessage[] {
  const availableTokens = maxContextLength - estimateTokenCount(systemPrompt, modelId) - 500;
  if (availableTokens <= 0) throw new ConversationContextError('Instructions leave no room for the current conversation');
  const normalized = messages.map(message => ({ ...prepareConversationMessage(message), ...(message.media ? { media: message.media } : {}) }));
  const groups = buildAtomicGroups(normalized, modelId, options);
  if (!groups.length) return [];
  const latest = groups[groups.length - 1];
  if (latest.atomic && latest.totalTokens > availableTokens) {
    throw new ConversationContextError('The current tool or media group does not fit the model context window');
  }
  const totalTokens = groups.reduce((sum, group) => sum + group.totalTokens, 0);
  let memoryReserve = totalTokens > availableTokens && groups.slice(0, -1).some(group =>
    group.messages.some(message => message.tool_calls?.length || ['tool', 'function'].includes(message.role)))
    ? Math.min(256, Math.floor(availableTokens / 4)) : 0;
  if (latest.totalTokens <= availableTokens) memoryReserve = Math.min(memoryReserve, availableTokens - latest.totalTokens);
  const bodyBudget = availableTokens - memoryReserve;
  const kept: MessageGroup[] = [];
  let usedTokens = 0;
  let droppedThrough = -1;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (usedTokens + group.totalTokens <= bodyBudget) {
      kept.push(group);
      usedTokens += group.totalTokens;
    } else {
      const remaining = bodyBudget - usedTokens;
      if (!group.atomic && remaining > 0) {
        const partial = fitPlainMessage(group.messages[0], remaining, modelId, options);
        if (partial) kept.push({ ...group, messages: [partial] });
      }
      droppedThrough = group.endIndex;
      break;
    }
  }
  const knownCalls = new Set(normalized.flatMap(message => message.tool_calls?.flatMap(call => call.id ? [call.id] : []) ?? []));
  const retained = kept.reverse().flatMap(group => group.messages);
  const retainedCalls = new Set(retained.flatMap(message => message.tool_calls?.flatMap(call => call.id ? [call.id] : []) ?? []));
  const result = retained.filter(message => !(['tool', 'function'].includes(message.role) && message.tool_call_id &&
    knownCalls.has(message.tool_call_id) && !retainedCalls.has(message.tool_call_id)));
  if (!result.length || (latest.atomic && !result.includes(normalized[normalized.length - 1]))) {
    throw new ConversationContextError('The current conversation cannot be retained as a complete group');
  }
  const memory = droppedThrough < 0 ? '' : buildToolMemory(normalized, droppedThrough + 1);
  const spare = Math.min(256, availableTokens - estimateTokenCount(serializeConversationMessages(result, options), modelId));
  if (memory && spare > 0) {
    const message = { role: 'user', content: `[Earlier tool memory]\n${memory}` };
    const summary = estimateTokenCount(serializeConversationMessages([message]), modelId) <= spare ? message
      : fitPlainMessage(message, spare, modelId);
    if (summary) result.unshift(summary);
  }
  return result;
}
