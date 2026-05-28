/*
 * File: chat-store.ts
 * Project: qwenproxy
 * Persistent chat storage and conversation compaction helpers.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '../utils/types.ts';

export type QwenMode = 'chat' | 'coder';

export interface ChatRecord {
  id: string;
  title: string;
  model: string | null;
  mode: QwenMode;
  summary: string | null;
  lastMessageId: string | null;
  lastResponseId: string | null;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  stats: {
    requestCount: number;
    assistantCount: number;
    approximateChars: number;
  };
}

export interface ChatListItem {
  id: string;
  title: string;
  model: string | null;
  mode: QwenMode;
  summary: string | null;
  lastMessageId: string | null;
  lastResponseId: string | null;
  messageCount: number;
  requestCount: number;
  assistantCount: number;
  approximateChars: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessagesResponse {
  chat: ChatListItem;
  messages: Message[];
  summary: string | null;
  totalMessages: number;
  returnedMessages: number;
  truncated: boolean;
}

export interface PromptBuildResult {
  messages: Message[];
  summaryUsed: string | null;
  wasCompacted: boolean;
}

export interface ChatModeInfo {
  id: QwenMode;
  title: string;
  description: string;
  modelHints: string[];
}

const DATA_DIR = path.resolve(process.env.QWENPROXY_DATA_DIR || 'qwen_data');
const CHAT_DIR = path.join(DATA_DIR, 'chats');
const MAX_PROMPT_MESSAGES = Number.parseInt(process.env.QWENPROXY_MAX_PROMPT_MESSAGES || '40', 10);
const MAX_PROMPT_CHARS = Number.parseInt(process.env.QWENPROXY_MAX_PROMPT_CHARS || '22000', 10);
const KEEP_RECENT_MESSAGES = Number.parseInt(process.env.QWENPROXY_KEEP_RECENT_MESSAGES || '16', 10);
const COMPACT_TRIGGER_MESSAGES = Number.parseInt(process.env.QWENPROXY_COMPACT_TRIGGER_MESSAGES || '60', 10);
const COMPACT_TRIGGER_CHARS = Number.parseInt(process.env.QWENPROXY_COMPACT_TRIGGER_CHARS || '30000', 10);
const DEFAULT_CHAT_MODE: QwenMode = 'chat';

const CHAT_MODES: ChatModeInfo[] = [
  {
    id: 'chat',
    title: 'Chat',
    description: 'Conversação geral, raciocínio, explicações e respostas de uso amplo.',
    modelHints: ['qwen', 'omni', 'chat']
  },
  {
    id: 'coder',
    title: 'Coder',
    description: 'Programação, refatoração, debugging, artefatos, diagramas e tarefas técnicas.',
    modelHints: ['coder', 'code', 'dev']
  }
];

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

const chatLocks = new Map<string, Mutex>();

function getChatLock(chatId: string): Mutex {
  const existing = chatLocks.get(chatId);
  if (existing) return existing;
  const lock = new Mutex();
  chatLocks.set(chatId, lock);
  return lock;
}

function legacySanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function encodeChatId(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeChatId(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    return encodeChatId(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

function filePathForChat(chatId: string): string {
  return path.join(CHAT_DIR, `${encodeChatId(chatId)}.json`);
}

function legacyFilePathForChat(chatId: string): string {
  return path.join(CHAT_DIR, `${legacySanitizeId(chatId)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeMode(mode?: string | null): QwenMode {
  return mode === 'coder' ? 'coder' : DEFAULT_CHAT_MODE;
}

export function inferModeFromModel(model?: string | null): QwenMode {
  const normalized = (model || '').toLowerCase();
  if (!normalized) return DEFAULT_CHAT_MODE;
  if (normalized.includes('coder') || normalized.includes('code') || normalized.includes('dev')) {
    return 'coder';
  }
  return DEFAULT_CHAT_MODE;
}

function stringifyContent(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null || message.content === undefined) return '';
  return JSON.stringify(message.content);
}

function messageFingerprint(message: Message): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    name: message.name,
    reasoning_content: message.reasoning_content
  });
}

function uniqueConsecutive(messages: Message[]): Message[] {
  const result: Message[] = [];
  let last = '';
  for (const msg of messages) {
    const fingerprint = messageFingerprint(msg);
    if (fingerprint === last) continue;
    last = fingerprint;
    result.push(cloneMessage(msg));
  }
  return result;
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message));
}

function countApproxChars(messages: Message[]): number {
  return messages.reduce((total, message) => total + stringifyContent(message).length + 64, 0);
}

function leadingSystemMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'system') break;
    result.push(cloneMessage(message));
  }
  return result;
}

function nonSystemMessages(messages: Message[]): Message[] {
  const start = leadingSystemMessages(messages).length;
  return messages.slice(start).map(cloneMessage);
}

function summarizeMessages(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = message.role;
    const text = stringifyContent(message).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = text.length > 240 ? `${text.slice(0, 240)}...` : text;
    if (role === 'assistant' && message.reasoning_content) {
      const reasoning = message.reasoning_content.replace(/\s+/g, ' ').trim();
      const clippedReasoning = reasoning.length > 160 ? `${reasoning.slice(0, 160)}...` : reasoning;
      lines.push(`- assistant reasoning: ${clippedReasoning}`);
    }
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolNames = message.tool_calls.map(tc => tc.function?.name || 'tool').join(', ');
      lines.push(`- assistant tool_calls: ${toolNames}`);
    }
    if (message.role === 'tool') {
      lines.push(`- tool ${message.name || message.tool_call_id || 'tool'}: ${clipped}`);
    } else {
      lines.push(`- ${role}: ${clipped}`);
    }
  }
  return lines.join('\n');
}

function inferTitleFromMessages(messages: Message[]): string {
  const firstUser = messages.find(message => message.role === 'user');
  const source = stringifyContent(firstUser || { role: 'user', content: '' }).trim();
  if (!source) return 'New chat';
  const collapsed = source.replace(/\s+/g, ' ');
  return collapsed.length > 64 ? `${collapsed.slice(0, 64).trim()}...` : collapsed;
}

function compactPromptMessages(messages: Message[], summary: string | null): PromptBuildResult {
  const cleaned = uniqueConsecutive(messages);
  const systems = leadingSystemMessages(cleaned);
  const body = cleaned.slice(systems.length);
  const totalChars = countApproxChars(cleaned);
  const needsCompact = cleaned.length > MAX_PROMPT_MESSAGES || totalChars > MAX_PROMPT_CHARS;

  if (!needsCompact && !summary) {
    return { messages: cleaned, summaryUsed: null, wasCompacted: false };
  }

  const recent = body.slice(-KEEP_RECENT_MESSAGES);
  const older = body.slice(0, Math.max(0, body.length - recent.length));
  const ephemeralSummary = summary || summarizeMessages(older);
  const summaryMessage: Message = {
    role: 'system',
    content: `Conversation summary so far:\n${ephemeralSummary}`
  };

  return {
    messages: [...systems, summaryMessage, ...recent],
    summaryUsed: ephemeralSummary,
    wasCompacted: true
  };
}

function compactPersistedRecord(record: ChatRecord): ChatRecord {
  const cleaned = uniqueConsecutive(record.messages);
  const systems = leadingSystemMessages(cleaned);
  const body = cleaned.slice(systems.length);
  const recent = body.slice(-KEEP_RECENT_MESSAGES);
  const older = body.slice(0, Math.max(0, body.length - recent.length));
  const summaryText = summarizeMessages(older);

  const nextSummary = record.summary
    ? `${record.summary}\n${summaryText}`.trim()
    : summaryText;

  return {
    ...record,
    summary: nextSummary || record.summary,
    messages: [...systems, ...recent],
    updatedAt: nowIso(),
    stats: {
      ...record.stats,
      approximateChars: countApproxChars([...systems, ...recent]),
    }
  };
}

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(CHAT_DIR, { recursive: true });
}

async function readChatFile(chatId: string): Promise<ChatRecord | null> {
  try {
    return await readChatFileAt(filePathForChat(chatId), chatId);
  } catch {
    try {
      return await readChatFileAt(legacyFilePathForChat(chatId), chatId);
    } catch {
      return null;
    }
  }
}

async function readChatFileAt(filePath: string, fallbackId: string): Promise<ChatRecord> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ChatRecord>;
  return {
    id: parsed.id || fallbackId,
    title: parsed.title || 'New chat',
    model: parsed.model || null,
    mode: parsed.mode || inferModeFromModel(parsed.model || null),
    summary: parsed.summary || null,
    lastMessageId: parsed.lastMessageId || null,
    lastResponseId: parsed.lastResponseId || null,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    createdAt: parsed.createdAt || nowIso(),
    updatedAt: parsed.updatedAt || nowIso(),
    stats: {
      requestCount: parsed.stats?.requestCount || 0,
      assistantCount: parsed.stats?.assistantCount || 0,
      approximateChars: parsed.stats?.approximateChars || 0
    }
  };
}

function buildChatListItem(chat: ChatRecord): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    mode: chat.mode,
    summary: chat.summary,
    lastMessageId: chat.lastMessageId,
    lastResponseId: chat.lastResponseId,
    messageCount: chat.messages.length,
    requestCount: chat.stats.requestCount,
    assistantCount: chat.stats.assistantCount,
    approximateChars: chat.stats.approximateChars,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

async function writeChatFile(chat: ChatRecord): Promise<void> {
  await ensureStorageDir();
  const filePath = filePathForChat(chat.id);
  const tmpPath = `${filePath}.${uuidv4()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(chat, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function listChats(): Promise<ChatListItem[]> {
  await ensureStorageDir();
  const entries = await fs.readdir(CHAT_DIR, { withFileTypes: true });
  const chats: ChatListItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const encodedId = entry.name.slice(0, -5);
    const chatId = decodeChatId(encodedId) || encodedId;
    const chat = await readChatFileAt(path.join(CHAT_DIR, entry.name), chatId).catch(() => null);
    if (chat) chats.push(buildChatListItem(chat));
  }

  chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return chats;
}

export async function getChat(chatId: string): Promise<ChatRecord | null> {
  return await readChatFile(chatId);
}

export async function createChat(input?: Partial<Pick<ChatRecord, 'id' | 'title' | 'model' | 'summary' | 'mode'>>): Promise<ChatRecord> {
  const chat: ChatRecord = {
    id: input?.id || `chat_${uuidv4()}`,
    title: input?.title || 'New chat',
    model: input?.model || null,
    mode: normalizeMode(input?.mode || inferModeFromModel(input?.model || null)),
    summary: input?.summary || null,
    lastMessageId: null,
    lastResponseId: null,
    messages: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stats: {
      requestCount: 0,
      assistantCount: 0,
      approximateChars: 0
    }
  };
  await writeChatFile(chat);
  return chat;
}

export async function upsertChat(chat: ChatRecord): Promise<ChatRecord> {
  const next = {
    ...chat,
    updatedAt: nowIso(),
    stats: {
      ...chat.stats,
      approximateChars: countApproxChars(chat.messages)
    }
  };
  await writeChatFile(next);
  return next;
}

export async function updateChat(
  chatId: string,
  patch: Partial<Pick<ChatRecord, 'title' | 'model' | 'summary' | 'mode'>>
): Promise<ChatRecord | null> {
  const lock = getChatLock(chatId);
  const release = await lock.acquire();
  try {
    const current = await getChat(chatId);
    if (!current) return null;

    const next: ChatRecord = {
      ...current,
      title: patch.title ?? current.title,
      model: patch.model ?? current.model,
      mode: patch.mode ?? current.mode ?? inferModeFromModel(patch.model ?? current.model),
      summary: patch.summary ?? current.summary,
      lastMessageId: current.lastMessageId,
      lastResponseId: current.lastResponseId,
      updatedAt: nowIso(),
      stats: {
        ...current.stats,
        approximateChars: countApproxChars(current.messages)
      }
    };

    await writeChatFile(next);
    return next;
  } finally {
    release();
  }
}

export async function ensureChat(chatId?: string, defaults?: Partial<Pick<ChatRecord, 'title' | 'model' | 'mode'>>): Promise<ChatRecord> {
  if (chatId) {
    const existing = await readChatFile(chatId);
    if (existing) return existing;
    return await createChat({
      id: chatId,
      title: defaults?.title,
      model: defaults?.model || null,
      mode: defaults?.mode || inferModeFromModel(defaults?.model || null)
    });
  }
  return await createChat({
    title: defaults?.title,
    model: defaults?.model || null,
    mode: defaults?.mode || inferModeFromModel(defaults?.model || null)
  });
}

export async function getChatMessages(
  chatId: string,
  options: {
    limit?: number;
    offset?: number;
  } = {}
): Promise<ChatMessagesResponse | null> {
  const chat = await getChat(chatId);
  if (!chat) return null;

  const limit = Math.max(1, Math.min(options.limit || chat.messages.length, 500));
  const offset = Math.max(0, options.offset || 0);
  const visible = chat.messages.slice(offset, offset + limit).map(cloneMessage);

  return {
    chat: buildChatListItem(chat),
    messages: visible,
    summary: chat.summary,
    totalMessages: chat.messages.length,
    returnedMessages: visible.length,
    truncated: chat.messages.length > visible.length,
  };
}

export function mergeChatMessages(existing: Message[], incoming: Message[]): Message[] {
  const clonedExisting = existing.map(cloneMessage);
  const clonedIncoming = incoming.map(cloneMessage);

  if (clonedExisting.length === 0) return clonedIncoming;
  if (clonedIncoming.length === 0) return clonedExisting;

  const existingKey = clonedExisting.map(messageFingerprint).join('|');
  const incomingKey = clonedIncoming.map(messageFingerprint).join('|');

  if (existingKey === incomingKey) return clonedExisting;

  const incomingStartsWithExisting =
    clonedIncoming.length >= clonedExisting.length &&
    clonedExisting.every((msg, idx) => messageFingerprint(msg) === messageFingerprint(clonedIncoming[idx]));
  if (incomingStartsWithExisting) {
    return clonedIncoming;
  }

  const existingStartsWithIncoming =
    clonedExisting.length >= clonedIncoming.length &&
    clonedIncoming.every((msg, idx) => messageFingerprint(msg) === messageFingerprint(clonedExisting[idx]));
  if (existingStartsWithIncoming) {
    return clonedExisting;
  }

  return [...clonedExisting, ...clonedIncoming];
}

export function buildPromptMessages(chat: ChatRecord, mergedMessages: Message[]): PromptBuildResult {
  return compactPromptMessages(mergedMessages, chat.summary);
}

export async function appendConversationTurn(
  chatId: string,
  incomingMessages: Message[],
  assistantMessage: Message,
  model: string,
  responseId?: string | null
): Promise<ChatRecord> {
  const lock = getChatLock(chatId);
  const release = await lock.acquire();
  try {
    const current = await ensureChat(chatId, { model });
    const merged = mergeChatMessages(current.messages, incomingMessages);
    const nextTitle = current.title === 'New chat'
      ? inferTitleFromMessages(merged)
      : current.title;
    const assistantMessageId = (assistantMessage as any).id || `msg_${uuidv4()}`;
    const persistedAssistantMessage = {
      ...assistantMessage,
      id: assistantMessageId
    };
    const next: ChatRecord = {
      ...current,
      model,
      title: nextTitle,
      mode: current.mode || inferModeFromModel(model),
      lastMessageId: assistantMessageId,
      lastResponseId: responseId || current.lastResponseId,
      messages: [...merged, cloneMessage(persistedAssistantMessage)],
      updatedAt: nowIso(),
      stats: {
        requestCount: current.stats.requestCount + 1,
        assistantCount: current.stats.assistantCount + 1,
        approximateChars: 0
      }
    };
    next.stats.approximateChars = countApproxChars(next.messages);

    const needsCompact =
      next.messages.length > COMPACT_TRIGGER_MESSAGES ||
      next.stats.approximateChars > COMPACT_TRIGGER_CHARS;

    const stored = needsCompact ? compactPersistedRecord(next) : next;
    await writeChatFile(stored);
    return stored;
  } finally {
    release();
  }
}

export async function replaceConversationTurn(
  chatId: string,
  incomingMessages: Message[],
  assistantMessage: Message,
  model: string,
  responseId?: string | null
): Promise<ChatRecord> {
  const lock = getChatLock(chatId);
  const release = await lock.acquire();
  try {
    const current = await ensureChat(chatId, { model });
    const cleanedIncoming = uniqueConsecutive(incomingMessages);
    const nextTitle = current.title === 'New chat'
      ? inferTitleFromMessages(cleanedIncoming)
      : current.title;
    const assistantMessageId = (assistantMessage as any).id || `msg_${uuidv4()}`;
    const persistedAssistantMessage = {
      ...assistantMessage,
      id: assistantMessageId
    };
    const next: ChatRecord = {
      ...current,
      model,
      title: nextTitle,
      mode: current.mode || inferModeFromModel(model),
      summary: null,
      lastMessageId: assistantMessageId,
      lastResponseId: responseId || current.lastResponseId,
      messages: [...cleanedIncoming, cloneMessage(persistedAssistantMessage)],
      updatedAt: nowIso(),
      stats: {
        requestCount: current.stats.requestCount + 1,
        assistantCount: current.stats.assistantCount + 1,
        approximateChars: 0
      }
    };
    next.stats.approximateChars = countApproxChars(next.messages);
    await writeChatFile(next);
    return next;
  } finally {
    release();
  }
}

export async function compactChat(chatId: string): Promise<ChatRecord | null> {
  const lock = getChatLock(chatId);
  const release = await lock.acquire();
  try {
    const current = await getChat(chatId);
    if (!current) return null;
    const compacted = compactPersistedRecord(current);
    await writeChatFile(compacted);
    return compacted;
  } finally {
    release();
  }
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const lock = getChatLock(chatId);
  const release = await lock.acquire();
  try {
    let deleted = false;
    for (const filePath of [filePathForChat(chatId), legacyFilePathForChat(chatId)]) {
      try {
        await fs.unlink(filePath);
        deleted = true;
      } catch {
        // Missing files are fine; callers only need to know whether anything was removed.
      }
    }
    return deleted;
  } finally {
    release();
  }
}

export function getConversationPrompt(chat: ChatRecord, incomingMessages: Message[]): PromptBuildResult {
  const merged = mergeChatMessages(chat.messages, incomingMessages);
  return buildPromptMessages(chat, merged);
}

export function estimateContextUsage(messages: Message[]): { messages: number; chars: number } {
  return {
    messages: messages.length,
    chars: countApproxChars(messages),
  };
}

export function listChatModes(): ChatModeInfo[] {
  return CHAT_MODES.map(mode => ({ ...mode }));
}

export function getChatModeLabel(mode: QwenMode): string {
  return CHAT_MODES.find(item => item.id === mode)?.title || 'Chat';
}
