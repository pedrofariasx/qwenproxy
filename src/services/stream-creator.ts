import { getQwenHeaders, getBasicHeaders, getGuestHeaders, getPageForAccount, browserFetch, browserStreamFetch, CHROME_CLIENT_HINTS } from './playwright.js';
import { MAX_PAYLOAD_SIZE } from '../core/model-registry.js';
import { config } from '../core/config.js';
import { RetryableQwenStreamError, QwenUpstreamError, handleErrorBody, handleJsonErrorBody } from './error-handler.js';
import { getWarmedChat, releaseWarmChat } from './warm-pool.js';
import crypto from 'crypto';

const CACHED_TIMEZONE = new Date().toString().split(' (')[0];
const BASE_TIMEOUT_MS = 120000;
const TIMEOUT_PER_MB = 30000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
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

function addIdleTimeoutToStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  onTimeout?: () => void,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      const message = `${label} idle timeout after ${idleTimeoutMs}ms without upstream data`;
      clearIdleTimer();
      controller.abort();
      onTimeout?.();
      try { stream.cancel(message).catch(() => {}); } catch { /* ignore */ }
    }, idleTimeoutMs);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
      resetIdleTimer();
    },
    async pull(streamController) {
      try {
        if (!reader) throw new Error('Stream reader was not initialized');
        const { done, value } = await reader.read();
        if (done) {
          clearIdleTimer();
          onDone?.();
          streamController.close();
          return;
        }
        resetIdleTimer();
        streamController.enqueue(value);
      } catch (err) {
        clearIdleTimer();
        onDone?.();
        streamController.error(err);
      }
    },
    cancel(reason) {
      clearIdleTimer();
      onDone?.();
      return stream.cancel(reason);
    },
  });
}

function getClientHintsHeaders(): Record<string, string> {
  return {
    'sec-ch-ua': CHROME_CLIENT_HINTS,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
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
    const page = getPageForAccount(accountId);
    if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
      try {
        const result = await browserFetch(page, 'https://chat.qwen.ai/api/v2/users/user/settings/update', {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-request-id': crypto.randomUUID(),
            'timezone': CACHED_TIMEZONE,
          },
          body: JSON.stringify(payload),
          timeoutMs: config.timeouts.http,
        });
        if (result.status && result.status < 400) {
          console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
          nativeToolsDisabled.add(cacheKey);
          return;
        }
        console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${result.status} - ${result.body}`);
        return;
      } catch (err: any) {
        console.warn('[Qwen] browserFetch failed for disableNativeTools, falling back:', err.message);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeouts.http);
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

  const page = getPageForAccount(accountId);
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const result = await browserFetch(page, 'https://chat.qwen.ai/api/models', {
        method: 'GET',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'x-request-id': crypto.randomUUID(),
          'timezone': CACHED_TIMEZONE,
          'source': 'web',
        },
        timeoutMs: config.timeouts.http,
      });
      if (result.status && result.status < 400) {
        return processModelsJson(JSON.parse(result.body));
      }
    } catch (err: any) {
      console.warn('[Qwen] browserFetch failed for models, falling back:', err.message);
    }
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
  return processModelsJson(json);
}

function processModelsJson(json: any): any[] {
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
    lastModelsFetch = Date.now();
    return extendedModels;
  }

  return [];
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
  let chatId: string;
  let chatHeaders: Record<string, string>;
  let leasedChat: any;
  let leasedChatReleased = false;

  const releaseLeasedChat = () => {
    if (leasedChatReleased || !leasedChat) return;
    leasedChatReleased = true;
    releaseWarmChat(leasedChat.accountId, leasedChat.chatId);
  };

  const wrapLeasedStream = (
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void,
  ) => {
    return addIdleTimeoutToStream(
      stream,
      controller,
      timeoutMs,
      label,
      onTimeout,
      () => {
        onTimeout?.();
        releaseLeasedChat();
      },
    );
  };

  if (accountId === 'guest') {
    chatHeaders = await getGuestHeaders();
    const guestPage = getPageForAccount('guest');
    const guestBody = JSON.stringify({
      title: 'Guest Chat',
      models: [modelId.replace('-no-thinking', '')],
      chat_mode: 'guest',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    if (guestPage && !guestPage.isClosed()) {
      try {
        const result = await browserFetch(guestPage, 'https://chat.qwen.ai/api/v2/chats/new', {
          method: 'POST',
          headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(), 'timezone': CACHED_TIMEZONE },
          body: guestBody,
          timeoutMs: config.timeouts.http,
        });
        if (!result.status || result.status >= 400) throw new Error(`Failed to create guest chat: ${result.status}`);
        const json = JSON.parse(result.body);
        chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
        if (!chatId) throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`);
      } catch (err: any) {
        console.warn('[Qwen] browserFetch guest chat failed, falling back:', err.message);
        const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
          method: 'POST',
          headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', cookie: chatHeaders['cookie'], origin: 'https://chat.qwen.ai', referer: 'https://chat.qwen.ai/c/guest', 'user-agent': chatHeaders['user-agent'], 'x-request-id': crypto.randomUUID(), 'bx-v': chatHeaders['bx-v'], 'bx-ua': chatHeaders['bx-ua'], 'bx-umidtoken': chatHeaders['bx-umidtoken'], ...getClientHintsHeaders() },
          body: guestBody,
          signal: AbortSignal.timeout(config.timeouts.http),
        });
        if (!response.ok) { throw new Error(`Failed to create guest chat: ${response.status}`, { cause: err }); }
        const json = await response.json();
        chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
        if (!chatId) { throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`, { cause: err }); }
      }
    } else {
      const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', cookie: chatHeaders['cookie'], origin: 'https://chat.qwen.ai', referer: 'https://chat.qwen.ai/c/guest', 'user-agent': chatHeaders['user-agent'], 'x-request-id': crypto.randomUUID(), 'bx-v': chatHeaders['bx-v'], 'bx-ua': chatHeaders['bx-ua'], 'bx-umidtoken': chatHeaders['bx-umidtoken'], ...getClientHintsHeaders() },
        body: guestBody,
        signal: AbortSignal.timeout(config.timeouts.http),
      });
      if (!response.ok) throw new Error(`Failed to create guest chat: ${response.status}`);
      const json = await response.json();
      chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
      if (!chatId) throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`);
    }
  } else {
    try {
      leasedChat = await getWarmedChat(accountId);
    } catch (err: any) {
      if (err.message?.includes('chat is in progress') || err.message?.includes('The chat is in progress')) {
        const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
        throw new RetryableQwenStreamError(`Qwen: ${err.message}`, retryAfterMs);
      }
      throw err;
    }
    chatId = leasedChat.chatId;
    chatHeaders = leasedChat.headers;
  }

  const actualParentId: string | null = null;

  const resolvedFiles = files || [];
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
      throw new Error(`Multimodal upload failed: ${err.message}`, { cause: err });
    }
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: accountId === 'guest' ? 'guest' : 'normal',
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

  const completionHeaders: Record<string, string> = {
    'accept': 'text/event-stream',
    'content-type': 'application/json',
    'x-request-id': crypto.randomUUID(),
    'timezone': CACHED_TIMEZONE,
  };

  const page = getPageForAccount(accountId);
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const browserResult = await browserStreamFetch(page, url, {
        method: 'POST',
        headers: completionHeaders,
        body: payloadJson,
        timeoutMs,
      });

      if (browserResult.contentType.includes('text/event-stream') && browserResult.status < 400) {
        const controller = new AbortController();
        return { stream: wrapLeasedStream(browserResult.stream, controller, timeoutMs, `Qwen browser stream ${chatId}`, browserResult.abort), headers: chatHeaders, uiSessionId: chatId, controller, accountId: accountId || 'guest' };
      }

      if (browserResult.body) {
        const peekText = browserResult.body;
        if (peekText.includes('FAIL_SYS_USER_VALIDATE') || peekText.includes('_____tmd_____') || peekText.includes('RGV587_ERROR')) {
          console.warn('[Qwen] TMD challenge detected via browser, refreshing headers and retrying...');
          try {
            const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
            await sleep(500 + Math.floor(Math.random() * 1000));
            const retryResult = await browserStreamFetch(page, url, {
              method: 'POST',
              headers: completionHeaders,
              body: payloadJson,
              timeoutMs,
            });
            if (retryResult.contentType.includes('text/event-stream') && retryResult.status < 400) {
              const controller = new AbortController();
              return { stream: wrapLeasedStream(retryResult.stream, controller, timeoutMs, `Qwen browser stream ${chatId}`, retryResult.abort), headers: freshHeaders, uiSessionId: chatId, controller, accountId: accountId || 'guest' };
            }
            if (retryResult.body && (retryResult.body.includes('FAIL_SYS_USER_VALIDATE') || retryResult.body.includes('_____tmd_____'))) {
              throw new QwenUpstreamError('Qwen TMD challenge persists after header refresh.', 'FAIL_SYS_USER_VALIDATE', 403);
            }
            if (retryResult.body) {
              handleErrorBody(retryResult.body, retryResult.status);
            }
          } catch (retryErr) {
            if (retryErr instanceof QwenUpstreamError) throw retryErr;
            console.error('[Qwen] Browser TMD retry failed:', (retryErr as Error).message);
          }
          throw new QwenUpstreamError('Qwen TMD anti-bot challenge detected. Headers were refreshed but the challenge persists.', 'FAIL_SYS_USER_VALIDATE', 403);
        }
        handleErrorBody(peekText, browserResult.status);
      }
    } catch (browserErr: any) {
      if (browserErr instanceof QwenUpstreamError || browserErr instanceof RetryableQwenStreamError) throw browserErr;
      console.warn('[Qwen] Browser stream fetch failed, falling back to Node.js:', browserErr.message);
    }
  }

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
      'referer': accountId === 'guest' ? 'https://chat.qwen.ai/c/guest' : `https://chat.qwen.ai/c/${chatId}`,
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
          return { stream: wrapLeasedStream(retryResponse.body, retryController, timeoutMs, `Qwen stream ${chatId}`), headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: accountId || 'guest' };
        }

        const retryPeek = await retryResponse.clone().text().catch(() => '');
        if (retryPeek.includes('FAIL_SYS_USER_VALIDATE') || retryPeek.includes('_____tmd_____')) {
          throw new QwenUpstreamError('Qwen TMD challenge persists after header refresh. The account may need manual captcha resolution.', 'FAIL_SYS_USER_VALIDATE', 403);
        }

        if (retryResponse.ok && retryResponse.body) {
          return { stream: wrapLeasedStream(retryResponse.body, retryController, timeoutMs, `Qwen stream ${chatId}`), headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: accountId || 'guest' };
        }
      } catch (retryErr) {
        if (retryErr instanceof QwenUpstreamError) throw retryErr;
        console.error('[Qwen] TMD retry failed:', (retryErr as Error).message);
      }

      throw new QwenUpstreamError('Qwen TMD anti-bot challenge detected. Headers were refreshed but the challenge persists.', 'FAIL_SYS_USER_VALIDATE', 403);
    } else {
      handleErrorBody(peekText, response.status);
    }
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      handleJsonErrorBody(errText);
    }
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: wrapLeasedStream(response.body, controller, timeoutMs, `Qwen stream ${chatId}`), headers: chatHeaders, uiSessionId: chatId, controller, accountId: accountId || 'guest' };
  } catch (err) {
    releaseLeasedChat();
    throw err;
  }
}
