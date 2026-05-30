/*
 * #==========# Response store
 * Persist OpenAI Responses-style conversation state in memory so
 * previous_response_id can resume the same conversation flow.
 */

import type { Message } from '../utils/types.ts';
import fs from 'node:fs';
import path from 'node:path';

type StoredResponse = {
  messages: Message[];
  createdAt: number;
};

type PersistedResponseStore = {
  responses: Record<string, StoredResponse>;
  sessions: Record<string, string>;
};

const storedResponses = new Map<string, StoredResponse>();
const sessionResponseIds = new Map<string, string>();
const storePath = process.env.RESPONSE_STORE_FILE
  || path.join(process.cwd(), '.data', 'responses-store.json');
let loaded = false;

function cloneMessage(message: Message): Message {
  return {
    ...message,
    tool_calls: message.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function },
    })),
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(storePath)) return;

  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedResponseStore;
    for (const [responseId, entry] of Object.entries(parsed.responses || {})) {
      if (!Array.isArray(entry.messages)) continue;
      storedResponses.set(responseId, {
        messages: entry.messages.map(cloneMessage),
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      });
    }
    for (const [sessionKey, responseId] of Object.entries(parsed.sessions || {})) {
      if (typeof responseId === 'string') sessionResponseIds.set(sessionKey, responseId);
    }
  } catch (err: any) {
    console.warn(`[response-store] Failed to load persisted Responses store: ${err.message}`);
  }
}

function persist(): void {
  ensureLoaded();
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const payload: PersistedResponseStore = {
      responses: Object.fromEntries(storedResponses.entries()),
      sessions: Object.fromEntries(sessionResponseIds.entries()),
    };
    fs.writeFileSync(storePath, JSON.stringify(payload, null, 2));
  } catch (err: any) {
    console.warn(`[response-store] Failed to persist Responses store: ${err.message}`);
  }
}

export function storeResponseContext(responseId: string, messages: Message[], sessionKey?: string | null): void {
  ensureLoaded();
  storedResponses.set(responseId, {
    messages: messages.map(cloneMessage),
    createdAt: Date.now(),
  });
  if (sessionKey) {
    sessionResponseIds.set(sessionKey, responseId);
  }
  persist();
}

export function getResponseContext(responseId?: string | null): Message[] {
  ensureLoaded();
  if (!responseId) return [];
  const entry = storedResponses.get(responseId);
  if (!entry) return [];
  return entry.messages.map(cloneMessage);
}

export function getSessionResponseId(sessionKey?: string | null): string | null {
  ensureLoaded();
  if (!sessionKey) return null;
  return sessionResponseIds.get(sessionKey) || null;
}

export function pruneResponseContexts(maxEntries = 250): void {
  ensureLoaded();
  if (storedResponses.size <= maxEntries) return;

  const entries = [...storedResponses.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt);

  while (entries.length > maxEntries) {
    const [responseId] = entries.shift()!;
    storedResponses.delete(responseId);
    for (const [sessionKey, sessionResponseId] of sessionResponseIds.entries()) {
      if (sessionResponseId === responseId) sessionResponseIds.delete(sessionKey);
    }
  }
  persist();
}
