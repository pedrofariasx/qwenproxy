/*
 * File: chats.ts
 * Project: qwenproxy
 * Persistent chat history API
 */

import type { Context } from 'hono';
import {
  compactChat,
  createChat,
  deleteChat,
  getChat,
  getChatMessages,
  inferModeFromModel,
  listChatModes,
  listChats,
  updateChat,
} from '../storage/chat-store.ts';

async function parseOptionalJsonBody(c: Context): Promise<{ ok: true; body: any } | { ok: false }> {
  try {
    const raw = await c.req.text();
    if (!raw.trim()) return { ok: true, body: {} };
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export async function listChatsHandler(c: Context) {
  const chats = await listChats();
  return c.json({ object: 'list', data: chats });
}

export async function listModesHandler(c: Context) {
  return c.json({
    object: 'list',
    data: listChatModes(),
    defaultMode: 'chat'
  });
}

export async function createChatHandler(c: Context) {
  const parsed = await parseOptionalJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: 'Malformed JSON body' } }, 400);
  const body = parsed.body;

  const mode = body?.mode || inferModeFromModel(body?.model || null);
  const chat = await createChat({
    title: body?.title,
    model: body?.model || null,
    mode,
  });
  return c.json({
    object: 'chat',
    data: chat,
    links: {
      self: `/v1/chats/${chat.id}`,
      messages: `/v1/chats/${chat.id}/messages`,
      compact: `/v1/chats/${chat.id}/compact`,
      mode: `/v1/chats/${chat.id}/mode`,
    }
  }, 201);
}

export async function getChatHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const chat = await getChat(chatId);
  if (!chat) return c.json({ error: { message: 'Chat not found' } }, 404);
  return c.json({ object: 'chat', data: chat });
}

export async function getChatModeHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const chat = await getChat(chatId);
  if (!chat) return c.json({ error: { message: 'Chat not found' } }, 404);
  const modeInfo = listChatModes().find(mode => mode.id === chat.mode) || null;
  return c.json({
    object: 'chat.mode',
    data: {
      chatId: chat.id,
      mode: chat.mode,
      title: modeInfo?.title || chat.mode,
      description: modeInfo?.description || null,
      modelHints: modeInfo?.modelHints || []
    }
  });
}

export async function patchChatHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const parsed = await parseOptionalJsonBody(c);
  if (!parsed.ok) return c.json({ error: { message: 'Malformed JSON body' } }, 400);
  const body = parsed.body;

  const patch: any = {};

  if (typeof body?.title === 'string') patch.title = body.title;
  if (typeof body?.model === 'string') patch.model = body.model;
  if (typeof body?.summary === 'string' || body?.summary === null) patch.summary = body.summary;
  if (body?.mode === 'chat' || body?.mode === 'coder') patch.mode = body.mode;

  const updated = await updateChat(chatId, patch);
  if (!updated) return c.json({ error: { message: 'Chat not found' } }, 404);
  return c.json({ object: 'chat', data: updated });
}

export async function getChatMessagesHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const limit = Number.parseInt(c.req.query('limit') || '200', 10);
  const offset = Number.parseInt(c.req.query('offset') || '0', 10);
  const payload = await getChatMessages(chatId, {
    limit: Number.isFinite(limit) ? limit : 200,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  if (!payload) return c.json({ error: { message: 'Chat not found' } }, 404);
  return c.json({ object: 'chat.messages', data: payload });
}

export async function deleteChatHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const deleted = await deleteChat(chatId);
  if (!deleted) return c.json({ error: { message: 'Chat not found' } }, 404);
  return c.json({ object: 'chat.deleted', id: chatId });
}

export async function compactChatHandler(c: Context) {
  const chatId = c.req.param('chatId')!;
  const chat = await compactChat(chatId);
  if (!chat) return c.json({ error: { message: 'Chat not found' } }, 404);
  return c.json({ object: 'chat', data: chat });
}
