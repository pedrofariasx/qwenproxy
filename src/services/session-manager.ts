/**
 * Server-side conversation session tracking for the hybrid send strategy.
 *
 * Two layers are tracked:
 * - `sessions`: maps a client-provided session key (OpenAI `user` field or
 *   `x-qwen-session` header) to a pinned Qwen chat_id + account + the last
 *   assistant response id. When complete, later turns can run in "economical"
 *   mode (send only system + last user message) because Qwen keeps the full
 *   conversation history server-side for that chat_id.
 * - `chatParents`: maps a chat_id to its last assistant response id so a new
 *   user message can be threaded with `parent_id` even without a session key.
 *
 * Sessions are persisted in SQLite so they survive a proxy restart; on recovery
 * the pinned chat (and therefore the server-side history) is re-used directly.
 */

import { config } from '../core/config.js';
import {
  listSessions,
  upsertSession,
  deleteSession,
} from '../core/database.js';
import { getDatabase } from '../core/database.js';

export interface SessionEntry {
  chatId: string;
  accountId: string;
  headers: Record<string, string>;
  parentId: string | null;
  historyComplete: boolean;
  updatedAt: number;
  instructionsHash?: string;
}

const MAX_SESSIONS = 2000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, SessionEntry>();
const chatToSession = new Map<string, string>();
const chatParents = new Map<string, { parentId: string | null; updatedAt: number }>();

let sessionsLoaded = false;
let lastCleanup = Date.now();

export function sessionTtlMs(): number {
  return config.hybridSessions.ttlMs || 24 * 60 * 60 * 1000;
}

function loadSessionsFromDb(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const rows = listSessions();
    const now = Date.now();
    for (const row of rows) {
      if (now - row.updated_at > sessionTtlMs()) {
        deleteSession(row.session_key);
        continue;
      }
      let headers: Record<string, string> = {};
      try {
        headers = JSON.parse(row.headers || '{}');
      } catch { /* keep empty */ }
      const entry: SessionEntry = {
        chatId: row.chat_id,
        accountId: row.account_id,
        headers,
        parentId: row.parent_id,
        historyComplete: row.history_complete !== 0,
        updatedAt: row.updated_at,
        instructionsHash: row.instructions_hash || undefined,
      };
      sessions.set(row.session_key, entry);
      chatToSession.set(row.chat_id, row.session_key);
      chatParents.set(row.chat_id, { parentId: row.parent_id, updatedAt: row.updated_at });
    }
    if (rows.length > 0) {
      console.log(`[Session] Restored ${rows.length} session(s) from SQLite`);
    }
  } catch (err: any) {
    console.warn(`[Session] Failed to restore sessions from SQLite:`, err.message);
  }
}

function persistSession(sessionKey: string, entry: SessionEntry): void {
  try {
    upsertSession({
      session_key: sessionKey,
      chat_id: entry.chatId,
      account_id: entry.accountId,
      headers: JSON.stringify(entry.headers || {}),
      parent_id: entry.parentId,
      history_complete: entry.historyComplete ? 1 : 0,
      updated_at: entry.updatedAt,
      instructions_hash: entry.instructionsHash,
    });
  } catch (err: any) {
    console.warn(`[Session] Failed to persist session ${sessionKey} to SQLite:`, err.message);
  }
}

function cleanupSessions(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS && sessions.size <= MAX_SESSIONS) return;
  lastCleanup = now;

  for (const [key, entry] of sessions.entries()) {
    if (now - entry.updatedAt > sessionTtlMs()) {
      sessions.delete(key);
      chatToSession.delete(entry.chatId);
      try { deleteSession(key); } catch { /* ignore */ }
    }
  }
  for (const [chatId, entry] of chatParents.entries()) {
    if (now - entry.updatedAt > sessionTtlMs()) {
      chatParents.delete(chatId);
    }
  }
}

export function getSession(sessionKey?: string | null): SessionEntry | undefined {
  if (!sessionKey) return undefined;
  loadSessionsFromDb();
  cleanupSessions();
  return sessions.get(sessionKey);
}

export function setSession(sessionKey: string, entry: SessionEntry): void {
  loadSessionsFromDb();
  cleanupSessions();
  const now = Date.now();
  const stored = { ...entry, updatedAt: now };
  chatToSession.delete(entry.chatId);
  sessions.set(sessionKey, stored);
  chatToSession.set(entry.chatId, sessionKey);
  chatParents.set(entry.chatId, { parentId: entry.parentId, updatedAt: now });
  persistSession(sessionKey, stored);
}

export function removeSession(sessionKey: string): void {
  loadSessionsFromDb();
  const entry = sessions.get(sessionKey);
  if (entry) {
    chatToSession.delete(entry.chatId);
    chatParents.delete(entry.chatId);
  }
  sessions.delete(sessionKey);
  try { deleteSession(sessionKey); } catch { /* ignore */ }
}

export function getSessionKeyByChatId(chatId: string): string | undefined {
  loadSessionsFromDb();
  return chatToSession.get(chatId);
}

/**
 * Resolves a client-provided session key to the canonical registry key. A
 * client may echo back the chat_id returned by the proxy; map it back to the
 * original session key so economical mode can continue.
 */
export function resolveSessionKey(sessionKey: string): string | undefined {
  loadSessionsFromDb();
  if (sessions.has(sessionKey)) return sessionKey;
  const byChat = chatToSession.get(sessionKey);
  return byChat ?? undefined;
}

/**
 * Records the last assistant response id for a chat_id. This is called early
 * in the stream to enable parent_id threading for subsequent messages.
 * Does NOT mark historyComplete — that happens only after successful stream completion.
 */
export function updateSessionParent(chatId: string, parentId: string | null): void {
  loadSessionsFromDb();
  const now = Date.now();
  chatParents.set(chatId, { parentId, updatedAt: now });
  const sessionKey = chatToSession.get(chatId);
  if (sessionKey) {
    const session = sessions.get(sessionKey);
    if (session) {
      session.parentId = parentId;
      session.updatedAt = now;
      persistSession(sessionKey, session);
    }
  }
}

/**
 * Marks a session's history as complete after the stream finishes successfully.
 * Only then can economical mode safely rely on Qwen's server-side history.
 */
export function markHistoryComplete(chatId: string): void {
  loadSessionsFromDb();
  const sessionKey = chatToSession.get(chatId);
  if (sessionKey) {
    const session = sessions.get(sessionKey);
    if (session && !session.historyComplete) {
      session.historyComplete = true;
      session.updatedAt = Date.now();
      persistSession(sessionKey, session);
    }
  }
}

export function getSessionParent(chatId: string): string | null {
  loadSessionsFromDb();
  return chatParents.get(chatId)?.parentId ?? null;
}

export function getSessionCount(): number {
  loadSessionsFromDb();
  cleanupSessions();
  return sessions.size;
}

/** Clears all in-memory and persisted sessions (test/ops helper). */
export function resetAllSessions(): void {
  sessions.clear();
  chatToSession.clear();
  chatParents.clear();
  sessionsLoaded = true;
  try {
    const db = getDatabase();
    db.prepare('DELETE FROM sessions').run();
  } catch { /* ignore */ }
}
