import { getQwenHeaders, getBasicHeaders } from './playwright.js';
import { MAX_PAYLOAD_SIZE } from '../core/model-registry.js';
import crypto from 'crypto';

const CACHED_TIMEZONE = new Date().toString().split(' (')[0];
const BASE_TIMEOUT_MS = 120000;
const TIMEOUT_PER_MB = 30000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getClientHintsHeaders(): Record<string, string> {
  return {
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}



export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

interface SessionEntry {
  parentId: string | null;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
}

export function updateSessionParent(sessionId: string, parentId: string | null) {
  if (sessionId) {
    if (sessionStates.size > 10000) cleanupStaleSessions();
    sessionStates.set(sessionId, { parentId, timestamp: Date.now() });
  }
}

function getSessionParent(sessionId: string): string | null | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  return entry.parentId;
}

interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  timestamp: number;
}

const warmPool: Map<string, WarmPoolEntry[]> = new Map();

const refillPromises: Map<string, Promise<void>> = new Map();

const WARM_POOL_SIZE = 10;
const WARM_POOL_TTL_MS = 10 * 60 * 1000;

function cleanupStalePool(accountId: string) {
  const pool = warmPool.get(accountId);
  if (!pool) return;
  const now = Date.now();
  const filtered = pool.filter(e => now - e.timestamp <= WARM_POOL_TTL_MS);
  if (filtered.length !== pool.length) warmPool.set(accountId, filtered);
}

async function getBasicQwenHeaders(accountId?: string): Promise<Record<string, string>> {
  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);
  return {
    cookie,
    'user-agent': userAgent,
    'bx-v': bxV,
    'bx-ua': bxUa || '',
    'bx-umidtoken': bxUmidtoken || '',
  };
}

async function createRealQwenChat(header: Record<string, string>): Promise<string> {
  const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      cookie: header['cookie'],
      origin: 'https://chat.qwen.ai',
      referer: 'https://chat.qwen.ai/c/new-chat',
      'user-agent': header['user-agent'],
      'x-request-id': crypto.randomUUID(),
      'bx-v': header['bx-v'],
      'bx-ua': header['bx-ua'] || '',
      'bx-umidtoken': header['bx-umidtoken'] || '',
      ...getClientHintsHeaders(),
    },
    body: JSON.stringify({
      title: 'Nova Conversa',
      models: ['qwen3.7-plus'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) throw new Error(`Failed to create chat: ${response.status}`);
  const json = await response.json();
  const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
  if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
  return chatId;
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

  const creationPromises = Array.from({ length: need }, async () => {
    try {
      const chatId = await createRealQwenChat(headers);
      return { chatId, headers, accountId, timestamp: Date.now() };
    } catch (err) {
      console.error(`[WarmPool] chat creation failed for ${accountId}:`, (err as Error).message);
      return null;
    }
  });

  const results = await Promise.all(creationPromises);
  for (const entry of results) {
    if (entry) pool.push(entry);
  }
}

export async function getWarmedChat(accountId?: string) {
  const key = accountId || 'global';
  let pool = warmPool.get(key);
  if (!pool) { pool = []; warmPool.set(key, pool); }
  cleanupStalePool(key);
  if (pool.length === 0) {
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) {
    // Retry once with short backoff if pool is still empty after first refill attempt
    await new Promise(r => setTimeout(r, 200));
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) throw new Error(`Warm pool empty after retry for ${key}`);
  return pool.shift()!;
}

export async function warmAllPools(accountIds: string[]) {
  for (const id of accountIds) refillPoolForAccount(id).catch(() => {});
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || 'global';
  if (nativeToolsDisabled.has(cacheKey) || disablingNativeToolsInProgress.has(cacheKey)) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    const { headers } = await getQwenHeaders(false, accountId);

    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false
      }
    };

    console.log(`[Qwen] Disabling native tools for ${cacheKey}...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': crypto.randomUUID(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${response.status} - ${text}`);
    } else {
      console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
      nativeToolsDisabled.add(cacheKey);
    }
  } catch (err: any) {
    console.error(`[Qwen] Error disabling native tools for ${cacheKey}: ${err.message}`);
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

export async function fetchQwenModels(accountId?: string): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) {
    return cachedModels;
  }

  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);

  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': crypto.randomUUID(),
      'bx-v': bxV,
      'bx-ua': bxUa || '',
      'bx-umidtoken': bxUmidtoken || '',
      'timezone': CACHED_TIMEZONE,
      'source': 'web',
      ...getClientHintsHeaders(),
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => ({
      id: m.id,
      object: 'model',
      created: m.info?.created_at || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'qwen'
    }));

    const hasPlus = models.some((m: any) => m.id === 'qwen3.7-plus');
    const base = [
      ...models,
      ...(hasPlus ? [] : [{ id: 'qwen3.7-plus', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'qwen' }])
    ];

    const extendedModels = [
      ...base,
      ...base.map((m: any) => ({ ...m, id: `${m.id}-no-thinking` }))
    ];

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  pendingMultimodal?: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>>
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string }> {
  let chatEntry: WarmPoolEntry;
  try {
    chatEntry = await getWarmedChat(accountId);
  } catch (err: any) {
    if (err.message?.includes('chat is in progress') || err.message?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${err.message}`, retryAfterMs);
    }
    throw err;
  }

  const chatId = chatEntry.chatId;
  const chatHeaders = chatEntry.headers;
  const actualParentId: string | null = null;

  // Process pending multimodal uploads — requires full headers with bx-ua/bx-umidtoken
  let resolvedFiles = files || [];
  if (pendingMultimodal && pendingMultimodal.length > 0 && resolvedFiles.length === 0) {
    try {
      const { processImagesForQwen } = await import('../routes/upload.ts');
      const { headers: fullHeaders } = await getQwenHeaders(false, accountId);
      const uploadHeaders: Record<string, string> = {
        cookie: fullHeaders['cookie'] || chatHeaders['cookie'] || '',
        'user-agent': fullHeaders['user-agent'] || chatHeaders['user-agent'] || '',
        'bx-ua': fullHeaders['bx-ua'] || '',
        'bx-umidtoken': fullHeaders['bx-umidtoken'] || '',
        'bx-v': fullHeaders['bx-v'] || chatHeaders['bx-v'] || '',
      };
      if (!uploadHeaders['bx-ua']) {
        console.warn('[Qwen] Missing bx-ua header for multimodal upload, attempting forced refresh...');
        const { headers: refreshedHeaders } = await getQwenHeaders(true, accountId);
        uploadHeaders['cookie'] = refreshedHeaders['cookie'] || uploadHeaders['cookie'];
        uploadHeaders['user-agent'] = refreshedHeaders['user-agent'] || uploadHeaders['user-agent'];
        uploadHeaders['bx-ua'] = refreshedHeaders['bx-ua'] || '';
        uploadHeaders['bx-umidtoken'] = refreshedHeaders['bx-umidtoken'] || '';
        uploadHeaders['bx-v'] = refreshedHeaders['bx-v'] || uploadHeaders['bx-v'];
      }
      const results = await Promise.all(
        pendingMultimodal.map(parts => processImagesForQwen(parts, uploadHeaders))
      );
      for (const r of results) {
        resolvedFiles.push(...r.files);
      }
    } catch (err: any) {
      console.error('[Qwen] Failed to process multimodal uploads:', err.message);
      throw new Error(`Multimodal upload failed: ${err.message}`);
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: resolvedFiles,
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const payloadJson = JSON.stringify(payload);
  const payloadSize = Buffer.byteLength(payloadJson);
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payloadSize} bytes exceeds limit of ${MAX_PAYLOAD_SIZE} bytes`);
  }
  const payloadMB = payloadSize / (1024 * 1024);
  const timeoutMs = BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB);

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': chatHeaders['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': `https://chat.qwen.ai/c/${chatId}`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': CACHED_TIMEZONE,
      'user-agent': chatHeaders['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': crypto.randomUUID(),
      'bx-v': chatHeaders['bx-v'],
      'bx-ua': chatHeaders['bx-ua'] || '',
      'bx-umidtoken': chatHeaders['bx-umidtoken'] || '',
      ...getClientHintsHeaders(),
    },
    body: payloadJson,
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  const responseContentType = response.headers.get('content-type') || '';
  if (response.ok && !responseContentType.includes('text/event-stream') && response.body) {
    const peekText = await response.clone().text().catch(() => '');
    if (peekText.includes('FAIL_SYS_USER_VALIDATE') || peekText.includes('_____tmd_____') || peekText.includes('RGV587_ERROR')) {
      console.warn('[Qwen] TMD challenge detected, refreshing headers and retrying...');
      try {
        const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
        await sleep(500 + Math.floor(Math.random() * 1000));
        const retryController = new AbortController();
        const retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs);
        const retryResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type': 'application/json',
            'cookie': freshHeaders['cookie'],
            'origin': 'https://chat.qwen.ai',
            'referer': `https://chat.qwen.ai/c/${chatId}`,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'timezone': CACHED_TIMEZONE,
            'user-agent': freshHeaders['user-agent'],
            'x-accel-buffering': 'no',
            'x-request-id': crypto.randomUUID(),
            'bx-v': freshHeaders['bx-v'],
            'bx-ua': freshHeaders['bx-ua'] || '',
            'bx-umidtoken': freshHeaders['bx-umidtoken'] || '',
            ...getClientHintsHeaders(),
          },
          body: payloadJson,
          signal: retryController.signal
        });
        clearTimeout(retryTimeoutId);

        const retryContentType = retryResponse.headers.get('content-type') || '';
        if (retryResponse.ok && retryContentType.includes('text/event-stream') && retryResponse.body) {
          return { stream: retryResponse.body, headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: chatEntry.accountId };
        }

        const retryPeek = await retryResponse.clone().text().catch(() => '');
        if (retryPeek.includes('FAIL_SYS_USER_VALIDATE') || retryPeek.includes('_____tmd_____')) {
          throw new QwenUpstreamError(
            'Qwen TMD challenge persists after header refresh. The account may need manual captcha resolution.',
            'FAIL_SYS_USER_VALIDATE',
            403,
          );
        }

        if (retryResponse.ok && retryResponse.body) {
          return { stream: retryResponse.body, headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: chatEntry.accountId };
        }
      } catch (retryErr) {
        if (retryErr instanceof QwenUpstreamError) throw retryErr;
        console.error('[Qwen] TMD retry failed:', (retryErr as Error).message);
      }

      throw new QwenUpstreamError(
        'Qwen TMD anti-bot challenge detected. Headers were refreshed but the challenge persists.',
        'FAIL_SYS_USER_VALIDATE',
        403,
      );
    }
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        if (errorJson?.data?.details?.includes('chat is in progress') ||
            errorJson?.data?.details?.includes('The chat is in progress')) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            retryAfterMs,
          );
        }
        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined
            ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
            : '';
          let status: number;
          if (code === 'RateLimited') status = 429;
          else if (code === 'Not_Found') status = 404;
          else if (code === 'UpstreamError') status = 502;
          else status = 502;
          throw new QwenUpstreamError(
            `Qwen upstream error: ${code}: ${details}.${wait}`,
            code,
            status,
          );
        }
        if (errorJson?.data?.details?.includes('is not exist') ||
            errorJson?.data?.details?.includes('not exist') ||
            errorJson.data?.details?.includes('does not exist')) {
          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            0,
          );
        }
      } catch (parseOrRetryError) {
        if (parseOrRetryError instanceof RetryableQwenStreamError ||
            parseOrRetryError instanceof QwenUpstreamError) {
          throw parseOrRetryError;
        }
      }
    }
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers: chatHeaders, uiSessionId: chatId, controller, accountId: chatEntry.accountId };
}
