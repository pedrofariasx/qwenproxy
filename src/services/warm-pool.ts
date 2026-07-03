import { getBasicHeaders, getPageForAccount } from './playwright.js';
import { markAccountRateLimited } from '../core/account-manager.js';
import { config } from '../core/config.js';
import { QwenUpstreamError } from './error-handler.js';
import type { Page } from 'playwright';
import crypto from 'crypto';

const CACHED_TIMEZONE = new Date().toString().split(' (')[0];
const QWEN_WEB_VERSION = '0.2.66';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  timestamp: number;
}

const warmPool: Map<string, WarmPoolEntry[]> = new Map();

const inFlightWarmChats = new Set<string>();

const refillPromises: Map<string, Promise<void>> = new Map();

const WARM_POOL_SIZE = config.warmPool.size;
const WARM_POOL_TTL_MS = config.warmPool.ttlMs;
const WARM_POOL_LOW_WATER = config.warmPool.lowWater;

function cleanupStalePool(accountId: string) {
  const pool = warmPool.get(accountId);
  if (!pool) return;
  const now = Date.now();
  const filtered = pool.filter(e => now - e.timestamp <= WARM_POOL_TTL_MS);
  if (filtered.length !== pool.length) warmPool.set(accountId, filtered);
}

function warmChatKey(accountId: string, chatId: string) {
  return `${accountId}:${chatId}`;
}

function markWarmChatInFlight(accountId: string, chatId: string) {
  inFlightWarmChats.add(warmChatKey(accountId, chatId));
}

export function releaseWarmChat(accountId: string, chatId: string) {
  inFlightWarmChats.delete(warmChatKey(accountId, chatId));
}

function isWarmChatInFlight(accountId: string, chatId: string) {
  return inFlightWarmChats.has(warmChatKey(accountId, chatId));
}

async function getBasicQwenHeaders(accountId?: string): Promise<Record<string, string>> {
  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);
  if (!cookie || !userAgent || !bxV || !bxUa || !bxUmidtoken) {
    throw new Error('Missing required browser anti-bot headers for warm pool');
  }
  return {
    cookie,
    'user-agent': userAgent,
    'bx-v': bxV,
    'bx-ua': bxUa,
    'bx-umidtoken': bxUmidtoken,
  };
}

async function browserJsonFetch<T>(page: Page, url: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string; json: T | null }> {
  return await page.evaluate(async ({ url, options }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        signal: controller.signal,
      });
      const body = await response.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* not json */ }
      return { status: response.status, body, json };
    } finally {
      clearTimeout(timeoutId);
    }
  }, { url, options });
}

async function createRealQwenChat(header: Record<string, string>, accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return process.env.TEST_SESSION_ID || `mock-chat-${crypto.randomUUID()}`;
  }

  const page = getPageForAccount(accountId);
  const body = JSON.stringify({
    title: 'Nova Conversa',
    models: ['qwen3.7-plus'],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Date.now(),
    project_id: '',
  });

  const pageUrl = page?.url() || '';
  const isOnQwenOrigin = pageUrl.includes('chat.qwen.ai');

  if (page && !page.isClosed() && isOnQwenOrigin) {
    try {
      const result = await browserJsonFetch<any>(page, 'https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-request-id': crypto.randomUUID(),
          'timezone': CACHED_TIMEZONE,
          'version': QWEN_WEB_VERSION,
          'source': 'web',
        },
        body,
        timeoutMs: config.timeouts.http,
      });

      if (result.status === 429) {
        throw new QwenUpstreamError('Qwen upstream error: RateLimited: Too many requests.', 'RateLimited', 429);
      }
      if (!result.status || result.status >= 400) {
        throw new Error(`Failed to create chat: ${result.status} - ${result.body}`);
      }
      const json = result.json ?? JSON.parse(result.body);
      if (json && json.success === false) {
        const code = json.data?.code || json.code || 'UpstreamError';
        const details = json.data?.details || json.message || 'Qwen returned an error';
        const wait = json.data?.num !== undefined ? ` Wait about ${json.data.num} hour(s) before trying again.` : '';
        let status = 502;
        if (code === 'RateLimited') status = 429;
        throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
      }
      const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
      if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
      return chatId;
    } catch (err: any) {
      if (err instanceof QwenUpstreamError) throw err;
      throw new Error(`Browser chat creation failed with active Qwen page: ${err.message}`, { cause: err });
    }
  }

  throw new Error(`Cannot create Qwen chat outside an active Qwen browser page for ${accountId || 'global'}. Refusing direct fetch to avoid TMD challenge.`);
}

async function fetchUnusedChats(headers: Record<string, string>, accountId?: string): Promise<string[]> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return [];

  const page = getPageForAccount(accountId);
  const url = 'https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true';
  const reqHeaders: Record<string, string> = {
    'accept': 'application/json, text/plain, */*',
    'x-request-id': crypto.randomUUID(),
    'timezone': CACHED_TIMEZONE,
    'source': 'web',
  };

  let body = '';
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const result = await browserJsonFetch<any>(page, url, {
        method: 'GET',
        headers: reqHeaders,
        timeoutMs: config.timeouts.http,
      });
      if (result.status && result.status < 400) {
        body = result.body;
      }
    } catch (err: any) {
      console.warn('[WarmPool] Isolated browser fetch failed for chat list with active Qwen context:', err.message);
      return [];
    }
  }

  if (!body) return [];

  try {
    const json = JSON.parse(body);
    if (!json.success || !Array.isArray(json.data)) return [];
    const unused: string[] = [];
    for (const chat of json.data) {
      if (chat.title === 'Nova Conversa' && chat.created_at === chat.updated_at) {
        unused.push(chat.id);
      }
    }
    return unused;
  } catch {
    return [];
  }
}

async function refillPoolForAccount(accountId: string) {
  let pool = warmPool.get(accountId);
  if (!pool) { pool = []; warmPool.set(accountId, pool); }
  cleanupStalePool(accountId);
  const need = Math.max(0, WARM_POOL_SIZE - pool.length);
  if (need === 0) return;

  let headers: Record<string, string>;
  try {
    const acctId = accountId === 'global' ? undefined : accountId;
    headers = await getBasicQwenHeaders(acctId);
  } catch (err) {
    console.error(`[WarmPool] header fetch failed for ${accountId}:`, (err as Error).message);
    return;
  }

  const acctId = accountId === 'global' ? undefined : accountId;
  const existingIds = new Set(pool.map(e => e.chatId));

  let reused = 0;
  try {
    const unusedChats = await fetchUnusedChats(headers, acctId);
    for (const chatId of unusedChats) {
      if (reused >= need) break;
      if (existingIds.has(chatId)) continue;
      if (isWarmChatInFlight(accountId, chatId)) continue;
      pool.push({ chatId, headers, accountId, timestamp: Date.now() });
      existingIds.add(chatId);
      reused++;
    }
    if (reused > 0) {
      console.log(`[WarmPool] Reused ${reused} existing unused chats for ${accountId}`);
    }
  } catch (err: any) {
    console.warn(`[WarmPool] Failed to fetch unused chats for ${accountId}:`, err.message);
  }

  const stillNeed = Math.max(0, need - reused);
  for (let i = 0; i < stillNeed; i++) {
    if (i > 0) {
      await sleep(300 + Math.floor(Math.random() * 700));
    }
    try {
      const chatId = await createRealQwenChat(headers, acctId);
      pool.push({ chatId, headers, accountId, timestamp: Date.now() });
    } catch (err: any) {
      if (err instanceof QwenUpstreamError) {
        if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
          const hourHint = err.message?.match(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
          console.warn(`[WarmPool] Account ${accountId} rate-limited during chat creation. Marked for cooldown.`);
          break;
        }
      }
      console.error(`[WarmPool] chat creation failed for ${accountId}:`, (err as Error).message);
    }
  }
}

export async function getWarmedChat(accountId?: string) {
  if (WARM_POOL_SIZE <= 0) {
    const acctId = accountId === 'global' ? undefined : accountId;
    const headers = await getBasicQwenHeaders(acctId);
    const chatId = await createRealQwenChat(headers, acctId);
    const key = accountId || 'global';
    markWarmChatInFlight(key, chatId);
    return { chatId, headers, accountId: key, timestamp: Date.now() };
  }

  const key = accountId || 'global';
  let pool = warmPool.get(key);
  if (!pool) { pool = []; warmPool.set(key, pool); }
  cleanupStalePool(key);

  if (pool.length < WARM_POOL_LOW_WATER && !refillPromises.has(key)) {
    refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
  }

  if (pool.length === 0) {
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) {
    await new Promise(r => setTimeout(r, 200));
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) throw new Error(`Warm pool empty after retry for ${key}`);
  const entry = pool.shift()!;
  markWarmChatInFlight(key, entry.chatId);
  return entry;
}

export async function warmAllPools(accountIds: string[]) {
  if (!config.warmPool.startup || WARM_POOL_SIZE <= 0) return;
  for (const id of accountIds) refillPoolForAccount(id).catch(() => {});
}
