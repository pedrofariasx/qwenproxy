import type { Page } from 'playwright';
import crypto from 'crypto';
import { config } from '../core/config.js';
import { startCaptchaWatcher } from './captcha-solver.js';

const streamCallbacks = new Map<string, {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
  onMeta: (meta: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  onBody: (body: string) => void;
}>();

const abortControllers = new Map<string, () => void>();

const pagesWithExposed = new WeakSet<Page>();

async function ensureStreamBridge(page: Page): Promise<void> {
  if (pagesWithExposed.has(page)) return;
  pagesWithExposed.add(page);
  await page.exposeFunction('__streamRelay', (reqId: string, type: string, data: any) => {
    const cb = streamCallbacks.get(reqId);
    if (!cb) return;
    switch (type) {
      case 'meta': cb.onMeta(data); break;
      case 'chunk': cb.onChunk(data); break;
      case 'end': cb.onEnd(); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
      case 'error': cb.onError(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
      case 'body': cb.onBody(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
    }
  });
}

export async function browserFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; statusText: string; contentType: string; body: string; headers: Record<string, string> }> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();

  const timeoutMs = options.timeoutMs || 30000;
  const watcher = startCaptchaWatcher(page, timeoutMs);

  try {
    if (page.isClosed()) throw new Error('Page is closed');
    return await page.evaluate(async ({ url, options }: any) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
      try {
        const resp = await fetch(url, {
          method: options.method || 'POST',
          headers: options.headers || {},
          body: options.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
        const body = await resp.text();
        return {
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get('content-type') || '',
          body,
          headers: respHeaders,
        };
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(`browserFetch failed: ${e.message}`, { cause: e });
      }
    }, { url, options, reqId });
  } catch (err: any) {
    if (err.message?.includes('Execution context was destroyed') || err.message?.includes('Target closed') || err.message?.includes('Page is closed')) {
      throw new Error(`browserFetch context lost: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    watcher.stop();
  }
}

export async function browserStreamFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  body: string;
  reqId: string;
  abort: () => void;
}> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();

  let metaResolve!: (value: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  let metaReject!: (reason: Error) => void;
  const metaPromise = new Promise<{ status: number; statusText: string; contentType: string; headers: Record<string, string> }>((resolve, reject) => {
    metaResolve = resolve;
    metaReject = reject;
  });

  const metaTimeoutMs = options.timeoutMs || config.timeouts.chat;
  const metaTimeout = setTimeout(() => {
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
    metaReject(new Error(`Browser stream fetch timed out waiting for response metadata after ${metaTimeoutMs}ms`));
  }, metaTimeoutMs);

  streamCallbacks.set(reqId, {
    onMeta: (meta) => {
      clearTimeout(metaTimeout);
      metaResolve(meta);
    },
    onChunk: () => {},
    onEnd: () => {},
    onError: (msg: string) => {
      clearTimeout(metaTimeout);
      metaReject(new Error(msg));
    },
    onBody: () => {},
  });

  let bodyResolve!: (value: string) => void;
  let bodyReject!: (reason: Error) => void;
  const bodyPromise = new Promise<string>((resolve, reject) => {
    bodyResolve = resolve;
    bodyReject = reject;
  });
  bodyPromise.catch(() => {});

  const watcher = startCaptchaWatcher(page, metaTimeoutMs);

  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cb = streamCallbacks.get(reqId);
        if (!cb) return;
        cb.onChunk = (chunk: string) => {
          try { controller.enqueue(enc.encode(chunk)); } catch { /* ignore */ }
        };
        cb.onEnd = () => {
          try { controller.close(); } catch { /* ignore */ }
          bodyResolve('');
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
        };
        cb.onError = (msg: string) => {
          try { controller.error(new Error(msg)); } catch { /* ignore */ }
          bodyReject(new Error(msg));
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
        };
        cb.onBody = (text: string) => {
          bodyResolve(text);
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
        };

        page.evaluate(async ({ url, options, reqId, evalTimeoutMs }: any) => {
          const controller = new AbortController();
          (window as any).__abortControllers = (window as any).__abortControllers || {};
          (window as any).__abortControllers[reqId] = controller;
          const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || evalTimeoutMs);
          try {
            const resp = await fetch(url, {
              method: options.method || 'POST',
              headers: options.headers || {},
              body: options.body || undefined,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
            (window as any).__streamRelay(reqId, 'meta', {
              status: resp.status,
              statusText: resp.statusText,
              contentType: resp.headers.get('content-type') || '',
              headers: respHeaders,
            });

            if (!resp.ok || !resp.body) {
              const bodyText = await resp.text();
              (window as any).__streamRelay(reqId, 'body', bodyText);
              delete (window as any).__abortControllers[reqId];
              return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            // Coalesce chunks before crossing the CDP bridge. Each __streamRelay call
            // is an expensive serialized round-trip; batching by time/size dramatically
            // reduces bridge overhead while keeping first-token latency low.
            const FLUSH_BYTES = 4096;
            const FLUSH_INTERVAL_MS = 15;
            let pending = '';
            let flushTimer: any = null;
            const flushPending = () => {
              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
              if (pending) {
                (window as any).__streamRelay(reqId, 'chunk', pending);
                pending = '';
              }
            };
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  flushPending();
                  (window as any).__streamRelay(reqId, 'end', null);
                  break;
                }
                pending += decoder.decode(value, { stream: true });
                if (pending.length >= FLUSH_BYTES) {
                  flushPending();
                } else if (!flushTimer) {
                  flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
                }
              }
            } finally {
              if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            }
            delete (window as any).__abortControllers[reqId];
          } catch (e: any) {
            clearTimeout(timeoutId);
            (window as any).__streamRelay(reqId, 'error', e.message);
            delete (window as any).__abortControllers[reqId];
          }
        }, { url, options, reqId, evalTimeoutMs: metaTimeoutMs }).catch((e: any) => {
          const cb = streamCallbacks.get(reqId);
          if (cb) {
            cb.onError(e.message);
          }
        });
      },
      cancel() {
        page.evaluate((reqId: string) => {
          const c = (window as any).__abortControllers?.[reqId];
          if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
        }, reqId).catch(() => {});
        streamCallbacks.delete(reqId);
        abortControllers.delete(reqId);
      },
    });

    const meta = await metaPromise;

    const abortFn = () => {
      page.evaluate((reqId: string) => {
        const c = (window as any).__abortControllers?.[reqId];
        if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
      }, reqId).catch(() => {});
      streamCallbacks.delete(reqId);
      abortControllers.delete(reqId);
    };

    abortControllers.set(reqId, abortFn);

    return {
      ...meta,
      stream,
      body: meta.contentType.includes('text/event-stream') ? '' : await bodyPromise,
      reqId,
      abort: abortFn,
    };
  } finally {
    watcher.stop();
  }
}
