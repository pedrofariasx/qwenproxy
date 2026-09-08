import { getQwenHeaders, getBasicHeaders, getGuestHeaders, getPageForAccount, waitForAccountPage, browserStreamFetch } from './playwright.js';
import { MAX_PAYLOAD_SIZE } from '../core/model-registry.js';
import { config } from '../core/config.js';
import { RetryableQwenStreamError, QwenUpstreamError, handleErrorBody, handleJsonErrorBody } from './error-handler.js';
import { getWarmedChat, releaseWarmChat } from './warm-pool.js';
import { getClientHintsHeaders } from './browser-manager.js';
import type { Page } from 'playwright';
import { releaseAccountInUse, acquireAccountStreamSlot } from '../core/account-manager.js';
import { getBaseAccountId } from '../core/account-lanes.js';
import { getRuntimeBool, getRuntimeInt } from '../core/runtime-config.js';
import { BAXIA_IFRAME_SELECTOR, solveBaxiaCaptcha } from './captcha-solver.js';
import { uploadLargePromptAsFile } from '../routes/upload.js';
import { getSession, setSession, getSessionParent, updateSessionParent } from './session-manager.js';
import { buildAnswerDirective } from '../utils/degenerate-answer.js';
import { sleep } from '../utils/sleep.js';
import { CACHED_TIMEZONE, QWEN_WEB_VERSION } from '../utils/qwen-constants.js';
import crypto from 'crypto';

export { updateSessionParent };

const BASE_TIMEOUT_MS = 120000;
const TIMEOUT_PER_MB = 30000;

function assertAntiBotHeaders(headers: Record<string, string>, label: string): void {
  if (!headers["cookie"] || !headers["user-agent"]) {
    throw new Error(`${label} missing required cookie or user-agent`);
  }
}

function isTmdChallenge(text: string): boolean {
  return text.includes('FAIL_SYS_USER_VALIDATE') || text.includes('_____tmd_____') || text.includes('RGV587_ERROR');
}

function buildBrowserCompletionHeaders(headers: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'timezone': CACHED_TIMEZONE,
    'version': QWEN_WEB_VERSION,
    'x-accel-buffering': 'no',
    'x-request-id': crypto.randomUUID(),
    'source': 'web',
  };
  if (headers['bx-v']) h['bx-v'] = headers['bx-v'];
  if (headers['bx-ua']) h['bx-ua'] = headers['bx-ua'];
  if (headers['bx-umidtoken']) h['bx-umidtoken'] = headers['bx-umidtoken'];
  return h;
}

function buildNodeCompletionHeaders(headers: Record<string, string>, chatId: string, accountId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'accept': 'application/json',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json',
    'cookie': headers['cookie'],
    'origin': 'https://chat.qwen.ai',
    'referer': accountId === 'guest' ? 'https://chat.qwen.ai/c/guest' : `https://chat.qwen.ai/c/${chatId}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'timezone': CACHED_TIMEZONE,
    'user-agent': headers['user-agent'],
    'version': QWEN_WEB_VERSION,
    'x-accel-buffering': 'no',
    'x-request-id': crypto.randomUUID(),
    'source': 'web',
    ...getClientHintsHeaders(accountId),
  };
  if (headers['bx-v']) h['bx-v'] = headers['bx-v'];
  if (headers['bx-ua']) h['bx-ua'] = headers['bx-ua'];
  if (headers['bx-umidtoken']) h['bx-umidtoken'] = headers['bx-umidtoken'];
  return h;
}

// ---------------------------------------------------------------------------
// Direct (Node-side) completion fast path with a per-account circuit breaker.
//
// The browser relay streams every SSE chunk across the CDP bridge
// (page.evaluate + __streamRelay), which is a serialized round-trip per chunk
// and also requires the lane page to be on the chat.qwen.ai origin. For
// multi-account setups the biggest throughput/latency lever is to POST the
// completion directly from Node using the already-captured anti-bot headers —
// no bridge, no page wait. If the backend answers with a TMD challenge or a
// body we cannot trust, we fall back to the proven browser relay. After
// repeated failures the circuit breaker opens per real account (5 min) so
// accounts that dislike direct fetches stay on the relay path automatically.
// ---------------------------------------------------------------------------

const directFetchFailures = new Map<string, number>();
const directFetchBlockedUntil = new Map<string, number>();
const DIRECT_FETCH_FAILURE_THRESHOLD = 3;
const DIRECT_FETCH_BLOCK_MS = 5 * 60 * 1000;

function canUseDirectFetch(accountId?: string): boolean {
  if (!getRuntimeBool('QWEN_DIRECT_FETCH', config.directFetch.enabled)) return false;
  if (!accountId || accountId === 'guest' || accountId === 'global') return false;
  const base = getBaseAccountId(accountId) || accountId;
  return (directFetchBlockedUntil.get(base) || 0) <= Date.now();
}

function recordDirectFetchSuccess(accountId?: string): void {
  if (!accountId) return;
  directFetchFailures.delete(getBaseAccountId(accountId) || accountId);
}

function recordDirectFetchFailure(accountId?: string): void {
  if (!accountId) return;
  const base = getBaseAccountId(accountId) || accountId;
  const failures = (directFetchFailures.get(base) || 0) + 1;
  directFetchFailures.set(base, failures);
  if (failures >= DIRECT_FETCH_FAILURE_THRESHOLD) {
    directFetchBlockedUntil.set(base, Date.now() + DIRECT_FETCH_BLOCK_MS);
    console.warn(`[Qwen] Direct fetch circuit opened for account ${base} for ${DIRECT_FETCH_BLOCK_MS / 1000}s after ${failures} consecutive failures`);
  }
}

/**
 * Attempts the completions POST directly from Node. Returns undefined for
 * anything that is not a clean SSE success so the caller falls back to the
 * browser relay. Real upstream failures (429 / RateLimited / chat in progress)
 * propagate instead of being doubled through the relay.
 */
async function tryDirectCompletionFetch(
  accountId: string,
  chatId: string,
  url: string,
  payloadJson: string,
  chatHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<{ stream: ReadableStream<Uint8Array>; controller: AbortController } | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildNodeCompletionHeaders(chatHeaders, chatId, accountId),
      body: payloadJson,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type') || '';
    if (response.ok && contentType.includes('text/event-stream') && response.body) {
      recordDirectFetchSuccess(accountId);
      return { stream: response.body as ReadableStream<Uint8Array>, controller };
    }

    const bodyText = await response.text().catch(() => '');
    if (isTmdChallenge(bodyText)) {
      recordDirectFetchFailure(accountId);
      return undefined;
    }
    if (!response.ok) {
      handleErrorBody(bodyText, response.status);
    }
    recordDirectFetchFailure(accountId);
    return undefined;
  } catch (err: any) {
    controller.abort();
    if (err instanceof QwenUpstreamError || err instanceof RetryableQwenStreamError) throw err;
    recordDirectFetchFailure(accountId);
    return undefined;
  }
}

async function openIsolatedQwenPage(basePage: Page, targetUrl = 'https://chat.qwen.ai/'): Promise<Page> {
  const page = await basePage.context().newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
  return page;
}

async function waitForTmdCaptcha(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.locator(BAXIA_IFRAME_SELECTOR).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function solveTmdChallengeIfPresent(page: Page, label: string): Promise<boolean> {
  const timeoutMs = Math.min(15000, Math.max(3000, config.timeouts.headers));
  const hasCaptcha = await waitForTmdCaptcha(page, timeoutMs);
  if (!hasCaptcha) {
    console.warn(`[Qwen] TMD challenge detected for ${label}, but no Baxia iframe appeared within ${timeoutMs}ms.`);
    return false;
  }

  console.log(`[Qwen] TMD Baxia iframe detected for ${label}; attempting solver before retry...`);
  return solveBaxiaCaptcha(page);
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

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

const sessionBusy = new Set<string>();

function isSessionBusy(sessionKey: string): boolean {
  return sessionBusy.has(sessionKey);
}

function markSessionBusy(sessionKey: string): void {
  sessionBusy.add(sessionKey);
}

function clearSessionBusy(sessionKey: string): void {
  sessionBusy.delete(sessionKey);
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
      let isolatedPage: Page | null = null;
      try {
        isolatedPage = await openIsolatedQwenPage(page);
        const result = await isolatedPage.evaluate(async ({ payload, timeoutMs, qwenVersion }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
              method: 'POST',
              headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-request-id': crypto.randomUUID(),
                'timezone': new Date().toString().split(' (')[0],
                'version': qwenVersion,
                'source': 'web',
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            const body = await response.text();
            return { status: response.status, body };
          } finally {
            clearTimeout(timeoutId);
          }
        }, { payload, timeoutMs: config.timeouts.http, qwenVersion: QWEN_WEB_VERSION });

        if (result.status && result.status < 400) {
          console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
          nativeToolsDisabled.add(cacheKey);
          return;
        }
        console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${result.status} - ${result.body}`);
        return;
      } catch (err: any) {
        console.warn('[Qwen] Isolated browser fetch failed for disableNativeTools with active Qwen context:', err.message);
        return;
      } finally {
        await isolatedPage?.close().catch(() => {});
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
        'version': QWEN_WEB_VERSION,
        'x-request-id': crypto.randomUUID(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v'],
        'source': 'web'
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
    let isolatedPage: Page | null = null;
    try {
      isolatedPage = await openIsolatedQwenPage(page);
      const result = await isolatedPage.evaluate(async ({ timeoutMs }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch('https://chat.qwen.ai/api/models', {
            method: 'GET',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'x-request-id': crypto.randomUUID(),
              'timezone': new Date().toString().split(' (')[0],
              'source': 'web',
            },
            signal: controller.signal,
          });
          const body = await response.text();
          return { status: response.status, body };
        } finally {
          clearTimeout(timeoutId);
        }
      }, { timeoutMs: config.timeouts.http });
      if (result.status && result.status < 400) {
        return processModelsJson(JSON.parse(result.body));
      }
    } catch (err: any) {
      console.warn('[Qwen] Isolated browser fetch failed for models with active Qwen context:', err.message);
      throw new Error(`Browser model fetch failed with active Qwen context: ${err.message}`, { cause: err });
    } finally {
      await isolatedPage?.close().catch(() => {});
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
      ...getClientHintsHeaders(accountId),
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
      ...base.map((m: any) => ({ ...m, id: `${m.id}-thinking` })),
      ...base.map((m: any) => ({ ...m, id: `${m.id}-no-thinking` }))
    ];

    cachedModels = extendedModels;
    lastModelsFetch = Date.now();
    return extendedModels;
  }

  return [];
}

export interface QwenChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  parentId?: string | null;
  childrenIds?: string[];
  timestamp?: number;
}

export interface QwenChatHistoryResult {
  chatId: string;
  messages: QwenChatHistoryMessage[];
  lastAssistantId: string | null;
  hasHistory: boolean;
}

function parseChatHistoryResponse(chatId: string, body: string): QwenChatHistoryResult {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return { chatId, messages: [], lastAssistantId: null, hasHistory: false };
  }
  if (!json?.success || !json.data?.chat) {
    return { chatId, messages: [], lastAssistantId: null, hasHistory: false };
  }

  const rawMessages: any[] = Array.isArray(json.data.chat.messages) ? json.data.chat.messages : [];
  const messages: QwenChatHistoryMessage[] = rawMessages
    .filter((m: any) => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : undefined,
      parentId: m.parentId ?? null,
      childrenIds: Array.isArray(m.childrenIds) ? m.childrenIds : [],
      timestamp: typeof m.timestamp === 'number' ? m.timestamp : undefined,
    }));

  let lastAssistantId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantId = messages[i].id;
      break;
    }
  }

  return { chatId, messages, lastAssistantId, hasHistory: messages.length > 0 };
}

/**
 * Fetches the server-side conversation history for a Qwen chat. The history is
 * kept by Qwen per chat_id, which is what economical mode relies on for context
 * without resending the whole conversation.
 */
export async function fetchQwenChatHistory(
  chatId: string,
  headers: Record<string, string>,
  accountId?: string,
  limit = 10,
): Promise<QwenChatHistoryResult> {
  const url = `https://chat.qwen.ai/api/v2/chats/${chatId}?direction=up&limit=${limit}`;
  const page = getPageForAccount(accountId);

  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    let isolatedPage: Page | null = null;
    try {
      isolatedPage = await openIsolatedQwenPage(page);
      const result = await isolatedPage.evaluate(async ({ url, timeoutMs }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'x-request-id': crypto.randomUUID(),
              'timezone': new Date().toString().split(' (')[0],
              'source': 'web',
            },
            signal: controller.signal,
          });
          const body = await response.text();
          return { status: response.status, body };
        } finally {
          clearTimeout(timeoutId);
        }
      }, { url, timeoutMs: config.timeouts.http });
      if (result.status && result.status < 400) {
        return parseChatHistoryResponse(chatId, result.body);
      }
    } catch (err: any) {
      console.warn(`[Qwen] Browser fetch failed for chat history ${chatId}:`, err.message);
    } finally {
      await isolatedPage?.close().catch(() => {});
    }
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'cookie': headers['cookie'] || '',
        'user-agent': headers['user-agent'] || '',
        'x-request-id': crypto.randomUUID(),
        'source': 'web',
        'timezone': CACHED_TIMEZONE,
      },
      signal: AbortSignal.timeout(config.timeouts.http),
    });
    if (!response.ok) {
      return { chatId, messages: [], lastAssistantId: null, hasHistory: false };
    }
    return parseChatHistoryResponse(chatId, await response.text());
  } catch (err: any) {
    console.warn(`[Qwen] Node fetch failed for chat history ${chatId}:`, err.message);
    return { chatId, messages: [], lastAssistantId: null, hasHistory: false };
  }
}

export interface CreateQwenStreamOptions {
  /** Client conversation key (OpenAI `user` field or x-qwen-session header). */
  sessionKey?: string;
  /** System + last user message only. Used when the server-side history can supply context. */
  economicalPrompt?: string;
  /** Skip reusing the pinned session chat and bootstrap the full conversation instead. */
  forceBootstrap?: boolean;
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  pendingMultimodal?: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>>,
  options?: CreateQwenStreamOptions,
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string }> {
  const sessionKey = options?.sessionKey;
  const session = sessionKey && !options?.forceBootstrap ? getSession(sessionKey) : undefined;

  const useEconomical = !!(
    sessionKey &&
    session?.historyComplete &&
    options?.economicalPrompt &&
    accountId !== 'guest' &&
    session.accountId !== 'guest' &&
    !isSessionBusy(sessionKey)
  );

  const effectiveAccountId = useEconomical
    ? (session!.accountId === 'global' ? undefined : session!.accountId)
    : accountId;

  let chatId: string;
  let chatHeaders: Record<string, string>;
  let leasedChat: any;
  let leasedChatReleased = false;
  const streamLockKey = effectiveAccountId || 'global';
  // Reserve a concurrency slot for the real account. All lanes share one
  // budget, so requests queue here (up to the configured wait) instead of
  // hammering the Qwen backend and tripping its per-account rate limits.
  const releaseAccountStream = await acquireAccountStreamSlot(streamLockKey, getRuntimeInt('ACCOUNT_STREAM_SLOT_WAIT_MS', config.accounts.streamSlotWaitMs));
  let accountStreamReleased = false;

  let sessionLocked = false;
  let usingPinnedChat = false;
  if (useEconomical) {
    markSessionBusy(sessionKey!);
    sessionLocked = true;
    usingPinnedChat = true;
  }

  const releaseAccountStreamOnce = () => {
    if (accountStreamReleased) return;
    accountStreamReleased = true;
    releaseAccountStream();
  };

  const releaseSessionBusy = () => {
    if (sessionLocked && sessionKey) {
      sessionLocked = false;
      clearSessionBusy(sessionKey);
    }
  };

  const releaseLeasedChat = () => {
    if (leasedChatReleased || !leasedChat) return;
    leasedChatReleased = true;
    releaseWarmChat(leasedChat.accountId, leasedChat.chatId);
    releaseAccountInUse(leasedChat.accountId);
  };

  const releaseStreamResources = () => {
    releaseLeasedChat();
    releaseSessionBusy();
    releaseAccountStreamOnce();
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
        releaseStreamResources();
      },
    );
  };

  const payloadPrompt = useEconomical && options?.economicalPrompt ? options.economicalPrompt : prompt;
  const LARGE_PROMPT_THRESHOLD = config.largePromptThreshold;
  const needsFileUpload = Buffer.byteLength(payloadPrompt, 'utf-8') > LARGE_PROMPT_THRESHOLD && !config.largePromptInline;

  let speculativeUpload: Promise<QwenFileEntry | null> | null = null;
  if (needsFileUpload) {
    speculativeUpload = (async () => {
      try {
        const { headers } = await getQwenHeaders(false, accountId);
        const uploadHeaders: Record<string, string> = {
          cookie: headers['cookie'] || '',
          'user-agent': headers['user-agent'] || '',
          'bx-ua': headers['bx-ua'] || '',
          'bx-umidtoken': headers['bx-umidtoken'] || '',
          'bx-v': headers['bx-v'] || '',
        };
        if (!uploadHeaders['bx-ua']) {
          const { headers: refreshed } = await getQwenHeaders(true, accountId);
          Object.assign(uploadHeaders, {
            cookie: refreshed['cookie'] || uploadHeaders['cookie'],
            'user-agent': refreshed['user-agent'] || uploadHeaders['user-agent'],
            'bx-ua': refreshed['bx-ua'],
            'bx-umidtoken': refreshed['bx-umidtoken'],
            'bx-v': refreshed['bx-v'] || uploadHeaders['bx-v'],
          });
        }
        assertAntiBotHeaders(uploadHeaders, 'Speculative large prompt upload');
        return await uploadLargePromptAsFile(payloadPrompt, uploadHeaders, accountId);
      } catch (err: any) {
        console.warn('[Qwen] Speculative upload failed, will retry after chat lease:', err.message);
        return null;
      }
    })();
  }

  if (useEconomical && session) {
    chatId = session.chatId;
    chatHeaders = session.headers;
    if (!chatHeaders['cookie'] || !chatHeaders['bx-ua'] || !chatHeaders['bx-umidtoken']) {
      try {
        const { headers } = await getQwenHeaders(true, session.accountId === 'global' ? undefined : session.accountId);
        chatHeaders = { ...headers };
        session.headers = chatHeaders;
      } catch (err: any) {
        console.warn(`[Session] Failed to refresh headers for session ${sessionKey}:`, err.message);
      }
    }
      assertAntiBotHeaders(chatHeaders, 'Pinned session');
    } else if (accountId === 'guest') {
    chatHeaders = await getGuestHeaders();
    assertAntiBotHeaders(chatHeaders, 'Guest session');
    const guestPage = getPageForAccount('guest');
    const guestBody = JSON.stringify({
      title: 'Guest Chat',
      models: [modelId.replace('-no-thinking', '').replace('-thinking', '')],
      chat_mode: 'guest',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    if (guestPage && !guestPage.isClosed()) {
      let isolatedPage: Page | null = null;
      try {
        isolatedPage = await openIsolatedQwenPage(guestPage, 'https://chat.qwen.ai/c/guest');
        const result = await isolatedPage.evaluate(async ({ body, timeoutMs }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
              method: 'POST',
              headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-request-id': crypto.randomUUID(),
                'timezone': new Date().toString().split(' (')[0],
              },
              body,
              signal: controller.signal,
            });
            return { status: response.status, body: await response.text() };
          } finally {
            clearTimeout(timeoutId);
          }
        }, { body: guestBody, timeoutMs: config.timeouts.http });
        if (!result.status || result.status >= 400) throw new Error(`Failed to create guest chat: ${result.status}`);
        const json = JSON.parse(result.body);
        chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
        if (!chatId) throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`);
      } catch (err: any) {
        throw new Error(`Browser guest chat creation failed with active Qwen page: ${err.message}`, { cause: err });
      } finally {
        await isolatedPage?.close().catch(() => {});
      }
    } else {
      const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', cookie: chatHeaders['cookie'], origin: 'https://chat.qwen.ai', referer: 'https://chat.qwen.ai/c/guest', 'user-agent': chatHeaders['user-agent'], 'x-request-id': crypto.randomUUID(), 'bx-v': chatHeaders['bx-v'], 'bx-ua': chatHeaders['bx-ua'], 'bx-umidtoken': chatHeaders['bx-umidtoken'], ...getClientHintsHeaders(accountId) },
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
      if (err.message?.includes('Warm pool empty after retry')) {
        const retryAfterMs = 1500 + Math.floor(Math.random() * 1500);
        throw new RetryableQwenStreamError(err.message, retryAfterMs);
      }
      throw err;
    }
    chatId = leasedChat.chatId;
    chatHeaders = leasedChat.headers;
    assertAntiBotHeaders(chatHeaders, 'Warm chat');
  }

  const actualParentId: string | null = forcedParentId ?? getSessionParent(chatId);

  const chatAccountKey = usingPinnedChat && session
    ? session.accountId
    : (accountId === 'guest' ? 'guest' : (accountId || 'global'));

  if (sessionKey && !useEconomical) {
    setSession(sessionKey, {
      chatId,
      accountId: chatAccountKey,
      headers: { ...chatHeaders },
      parentId: actualParentId,
      historyComplete: false,
      updatedAt: Date.now(),
    });
    console.log(`[Session] Registered session ${sessionKey} -> chat ${chatId} on account ${chatAccountKey}`);
  }

  const returnAccountKey = chatAccountKey;

  const resolvedFiles = files || [];
  let finalPrompt = payloadPrompt;
  if (Buffer.byteLength(finalPrompt, 'utf-8') > LARGE_PROMPT_THRESHOLD) {
    if (config.largePromptInline) {
      console.log(`[Qwen] Large prompt (${Buffer.byteLength(finalPrompt, 'utf-8')} bytes) exceeds ${LARGE_PROMPT_THRESHOLD}; inlined per LARGE_PROMPT_INLINE=true (anti-bot risk).`);
      finalPrompt = `${finalPrompt}\n${buildAnswerDirective()}`;
    } else {
      try {
        const largePromptFile = await (speculativeUpload ?? Promise.resolve(null));
        if (largePromptFile) {
          console.log(`[Qwen] Prompt exceeds ${LARGE_PROMPT_THRESHOLD} bytes, uploaded as file: ${largePromptFile.name}`);
          resolvedFiles.push(largePromptFile);
          finalPrompt = `[SYSTEM DIRECTIVE] The uploaded file "${largePromptFile.name}" contains the system prompt, persona, and the user's complete request. Read the attached file in full, internalize its instructions, and answer the user's request completely, in the same language. NEVER reply with only a short acknowledgment such as "Yes", "OK", or "Sim". [/SYSTEM DIRECTIVE]`;
          console.log(`[Qwen] Attached large prompt as file (${largePromptFile.size} bytes); content delivered via attachment, not inlined.`);
        } else {
          const uploadHeaders: Record<string, string> = {
            cookie: chatHeaders['cookie'] || '',
            'user-agent': chatHeaders['user-agent'] || '',
            'bx-ua': chatHeaders['bx-ua'] || '',
            'bx-umidtoken': chatHeaders['bx-umidtoken'] || '',
            'bx-v': chatHeaders['bx-v'] || '',
          };
          if (!uploadHeaders['bx-ua']) {
            console.warn('[Qwen] Missing bx-ua header for large prompt upload, attempting forced refresh...');
            const { headers: refreshedHeaders } = await getQwenHeaders(true, accountId);
            Object.assign(uploadHeaders, {
              cookie: refreshedHeaders['cookie'] || uploadHeaders['cookie'],
              'user-agent': refreshedHeaders['user-agent'] || uploadHeaders['user-agent'],
              'bx-ua': refreshedHeaders['bx-ua'],
              'bx-umidtoken': refreshedHeaders['bx-umidtoken'],
              'bx-v': refreshedHeaders['bx-v'] || uploadHeaders['bx-v'],
            });
          }
          assertAntiBotHeaders(uploadHeaders, 'Large prompt upload');
          const fallbackFile = await uploadLargePromptAsFile(finalPrompt, uploadHeaders, accountId);
          if (fallbackFile) {
            resolvedFiles.push(fallbackFile);
            finalPrompt = `[SYSTEM DIRECTIVE] The uploaded file "${fallbackFile.name}" contains the system prompt, persona, and the user's complete request. Read the attached file in full, internalize its instructions, and answer the user's request completely, in the same language. NEVER reply with only a short acknowledgment such as "Yes", "OK", or "Sim". [/SYSTEM DIRECTIVE]`;
          }
        }
      } catch (err: any) {
        console.warn('[Qwen] Failed to upload large prompt as file, sending inline:', err.message);
      }
    }
  }

  if (pendingMultimodal && pendingMultimodal.length > 0) {
    try {
      const { processImagesForQwen } = await import('../routes/upload.js');
      const { headers: fullHeaders } = await getQwenHeaders(false, accountId);
      const uploadHeaders: Record<string, string> = {
        cookie: fullHeaders['cookie'] || chatHeaders['cookie'] || '',
        'user-agent': fullHeaders['user-agent'] || chatHeaders['user-agent'] || '',
        'bx-ua': fullHeaders['bx-ua'],
        'bx-umidtoken': fullHeaders['bx-umidtoken'],
        'bx-v': fullHeaders['bx-v'] || chatHeaders['bx-v'] || '',
      };
      if (!uploadHeaders['bx-ua']) {
        console.warn('[Qwen] Missing bx-ua header for multimodal upload, attempting forced refresh...');
        const { headers: refreshedHeaders } = await getQwenHeaders(true, accountId);
        uploadHeaders['cookie'] = refreshedHeaders['cookie'] || uploadHeaders['cookie'];
        uploadHeaders['user-agent'] = refreshedHeaders['user-agent'] || uploadHeaders['user-agent'];
        uploadHeaders['bx-ua'] = refreshedHeaders['bx-ua'];
        uploadHeaders['bx-umidtoken'] = refreshedHeaders['bx-umidtoken'];
        uploadHeaders['bx-v'] = refreshedHeaders['bx-v'] || uploadHeaders['bx-v'];
      }
      assertAntiBotHeaders(uploadHeaders, 'Multimodal upload');
      const results = await Promise.all(
        pendingMultimodal.map(parts => processImagesForQwen(parts, uploadHeaders))
      );
      const docTextParts: string[] = [];
      for (const r of results) {
        resolvedFiles.push(...r.files);
        if (r.docText) docTextParts.push(r.docText);
      }
      if (docTextParts.length > 0) {
        const size = Buffer.byteLength(docTextParts.join('\n'), 'utf-8');
        console.log(`[Qwen] Inlined ${docTextParts.length} text document(s) (${size} bytes) into the prompt.`);
        finalPrompt = `${finalPrompt}\n\n[DOCUMENTS ATTACHED BY THE USER — read their contents below and incorporate them into your answer]\n${docTextParts.join('\n\n---\n\n')}\n${buildAnswerDirective()}`;
      }
    } catch (err: any) {
      console.error('[Qwen] Failed to process multimodal uploads:', err.message);
      throw new Error(`Multimodal upload failed: ${err.message}`, { cause: err });
    }
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const fid = crypto.randomUUID();
    const model = modelId.replace('-no-thinking', '').replace('-thinking', '');

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
          content: finalPrompt,
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
            thinking_mode: modelId.endsWith('-thinking') ? 'Thinking' : 'Auto',
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

    // Direct fast path: POST from Node with the captured anti-bot headers,
    // skipping both the CDP bridge and the page-readiness wait. Anything but a
    // clean SSE success falls back to the browser relay below, and the
    // per-account circuit breaker opens after repeated failures.
    if (
      effectiveAccountId &&
      !process.env.TEST_MOCK_PLAYWRIGHT &&
      canUseDirectFetch(effectiveAccountId)
    ) {
      const direct = await tryDirectCompletionFetch(
        effectiveAccountId,
        chatId,
        url,
        payloadJson,
        chatHeaders,
        timeoutMs,
      );
      if (direct) {
        const controller = direct.controller;
        return {
          stream: wrapLeasedStream(direct.stream, controller, timeoutMs, `Qwen direct stream ${chatId}`, () => controller.abort()),
          headers: chatHeaders,
          uiSessionId: chatId,
          controller,
          accountId: returnAccountKey,
        };
      }
    }

    // The lane's page can transiently be off-origin (mid-`goto`, blank while a
    // background header capture is warming it). Instead of instantly refusing
    // (which failed bursts of requests right after startup), wait for it to
    // reach chat.qwen.ai and drive it back there if needed.
    const page = process.env.TEST_MOCK_PLAYWRIGHT
      ? getPageForAccount(effectiveAccountId)
      : await waitForAccountPage(effectiveAccountId, 15000);
    if (page) {
      const completionPage = page;
      try {
        const browserResult = await browserStreamFetch(completionPage, url, {
          method: 'POST',
          headers: buildBrowserCompletionHeaders(chatHeaders),
          body: payloadJson,
          timeoutMs,
        });

        if (browserResult.contentType.includes('text/event-stream') && browserResult.status < 400) {
          const controller = new AbortController();
          return {
            stream: wrapLeasedStream(browserResult.stream, controller, timeoutMs, `Qwen browser stream ${chatId}`, () => {
              browserResult.abort();
            }),
            headers: chatHeaders,
            uiSessionId: chatId,
            controller,
            accountId: returnAccountKey
          };
        }

        if (browserResult.body) {
          const peekText = browserResult.body;
          if (isTmdChallenge(peekText)) {
            console.warn('[Qwen] TMD challenge detected via browser, attempting captcha solve before retry...');
            try {
              await solveTmdChallengeIfPresent(completionPage, `chat ${chatId}`);
              const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
              await sleep(500 + Math.floor(Math.random() * 1000));
              const retryResult = await browserStreamFetch(completionPage, url, {
                method: 'POST',
                headers: buildBrowserCompletionHeaders(freshHeaders),
                body: payloadJson,
                timeoutMs,
              });
              if (retryResult.contentType.includes('text/event-stream') && retryResult.status < 400) {
                const controller = new AbortController();
                return {
                  stream: wrapLeasedStream(retryResult.stream, controller, timeoutMs, `Qwen browser stream ${chatId}`, () => {
                    retryResult.abort();
                  }),
                  headers: freshHeaders,
                  uiSessionId: chatId,
                  controller,
                  accountId: returnAccountKey
                };
              }
              if (retryResult.body && isTmdChallenge(retryResult.body)) {
                await solveTmdChallengeIfPresent(completionPage, `chat ${chatId} retry`);
                throw new QwenUpstreamError('Qwen TMD challenge persists after captcha solve and header refresh.', 'FAIL_SYS_USER_VALIDATE', 403);
              }
              if (retryResult.body) {
                handleErrorBody(retryResult.body, retryResult.status);
              }
            } catch (retryErr) {
              if (retryErr instanceof QwenUpstreamError) throw retryErr;
              console.error('[Qwen] Browser TMD retry failed:', (retryErr as Error).message);
            }
            throw new QwenUpstreamError('Qwen TMD anti-bot challenge detected. Captcha solve/header refresh was attempted but the challenge persists.', 'FAIL_SYS_USER_VALIDATE', 403);
          }
          handleErrorBody(peekText, browserResult.status);
        }

        if (browserResult.status < 400 && !browserResult.contentType.includes('text/event-stream') && !browserResult.body) {
          console.warn(`[Qwen] Browser stream returned 200 OK with empty non-stream body for ${chatId}. Retrying with fresh headers...`);
          try {
            await sleep(1000 + Math.floor(Math.random() * 1000));
            const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
            const retryResult = await browserStreamFetch(completionPage, url, {
              method: 'POST',
              headers: buildBrowserCompletionHeaders(freshHeaders),
              body: payloadJson,
              timeoutMs,
            });
            if (retryResult.contentType.includes('text/event-stream') && retryResult.status < 400) {
              const controller = new AbortController();
              return {
                stream: wrapLeasedStream(retryResult.stream, controller, timeoutMs, `Qwen browser stream ${chatId}`, () => {
                  retryResult.abort();
                }),
                headers: freshHeaders,
                uiSessionId: chatId,
                controller,
                accountId: returnAccountKey
              };
            }
            if (retryResult.body) {
              handleErrorBody(retryResult.body, retryResult.status);
            }
          } catch (retryErr) {
            console.error(`[Qwen] Retry with fresh headers also failed for ${chatId}:`, (retryErr as Error).message);
          }
        }

        throw new RetryableQwenStreamError(`Qwen browser stream returned empty non-stream ${browserResult.status} response for ${chatId}. The chat may still be processing the previous message.`, 2000 + Math.floor(Math.random() * 2000));
      } catch (browserErr: any) {
        if (browserErr instanceof QwenUpstreamError || browserErr instanceof RetryableQwenStreamError) throw browserErr;
        throw new Error(`Browser stream fetch failed with active Qwen page: ${browserErr.message}`, { cause: browserErr });
      }
    }

    if (!process.env.TEST_MOCK_PLAYWRIGHT) {
      throw new Error(`Cannot fetch Qwen completion outside an active Qwen browser page for ${accountId || 'global'}. Refusing direct fetch to avoid TMD challenge.`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildNodeCompletionHeaders(chatHeaders, chatId, accountId),
      body: payloadJson,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const responseContentType = response.headers.get('content-type') || '';
    if (process.env.TEST_MOCK_PLAYWRIGHT && response.ok && response.body) {
      return { stream: wrapLeasedStream(response.body, controller, timeoutMs, `Qwen stream ${chatId}`), headers: chatHeaders, uiSessionId: chatId, controller, accountId: returnAccountKey };
    }

    if (response.ok && !responseContentType.includes('text/event-stream') && response.body) {
      const peekText = await response.clone().text().catch(() => '');
      if (isTmdChallenge(peekText)) {
        console.warn('[Qwen] TMD challenge detected, attempting browser captcha solve before retry...');
        try {
          const challengePage = getPageForAccount(accountId);
          if (challengePage && !challengePage.isClosed() && challengePage.url().includes('chat.qwen.ai')) {
            await solveTmdChallengeIfPresent(challengePage, `chat ${chatId}`);
          }
          const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
          await sleep(500 + Math.floor(Math.random() * 1000));
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs);
          const retryResponse = await fetch(url, {
            method: 'POST',
            headers: buildNodeCompletionHeaders(freshHeaders, chatId, accountId),
            body: payloadJson,
            signal: retryController.signal
          });
          clearTimeout(retryTimeoutId);

          const retryContentType = retryResponse.headers.get('content-type') || '';
          if (retryResponse.ok && retryContentType.includes('text/event-stream') && retryResponse.body) {
            return { stream: wrapLeasedStream(retryResponse.body, retryController, timeoutMs, `Qwen stream ${chatId}`), headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: returnAccountKey };
          }

          const retryPeek = await retryResponse.clone().text().catch(() => '');
          if (isTmdChallenge(retryPeek)) {
            const challengePage = getPageForAccount(accountId);
            if (challengePage && !challengePage.isClosed() && challengePage.url().includes('chat.qwen.ai')) {
              await solveTmdChallengeIfPresent(challengePage, `chat ${chatId} retry`);
            }
            throw new QwenUpstreamError('Qwen TMD challenge persists after captcha solve and header refresh. The account may need manual captcha resolution.', 'FAIL_SYS_USER_VALIDATE', 403);
          }

          if (retryResponse.ok && retryResponse.body) {
            return { stream: wrapLeasedStream(retryResponse.body, retryController, timeoutMs, `Qwen stream ${chatId}`), headers: freshHeaders, uiSessionId: chatId, controller: retryController, accountId: returnAccountKey };
          }
        } catch (retryErr) {
          if (retryErr instanceof QwenUpstreamError) throw retryErr;
          console.error('[Qwen] TMD retry failed:', (retryErr as Error).message);
        }

        throw new QwenUpstreamError('Qwen TMD anti-bot challenge detected. Captcha solve/header refresh was attempted but the challenge persists.', 'FAIL_SYS_USER_VALIDATE', 403);
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

    return { stream: wrapLeasedStream(response.body, controller, timeoutMs, `Qwen stream ${chatId}`), headers: chatHeaders, uiSessionId: chatId, controller, accountId: returnAccountKey };
  } catch (err) {
    releaseStreamResources();
    throw err;
  }
}