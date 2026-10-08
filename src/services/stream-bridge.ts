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
      case 'end': cb.onEnd(); streamCallbacks.delete(reqId); break;
      case 'error': cb.onError(data); streamCallbacks.delete(reqId); break;
      case 'body': cb.onBody(data); streamCallbacks.delete(reqId); break;
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
    signal?: AbortSignal;
    closeOnAbortTimeout?: boolean;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  body: string;
  reqId: string;
  abort: () => Promise<void>;
}> {
  options.signal?.throwIfAborted();
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();
  const timeoutMs = options.timeoutMs || config.timeouts.chat;
  const watcher = startCaptchaWatcher(page, timeoutMs);
  let output: ReadableStreamDefaultController<Uint8Array>;
  let terminal = false;
  let evaluation: Promise<void> = Promise.resolve();
  let aborting: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let metaResolve!: (meta: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  let metaReject!: (error: Error) => void;
  const metadata = new Promise<Parameters<typeof metaResolve>[0]>((resolve, reject) => {
    metaResolve = resolve;
    metaReject = reject;
  });
  let bodyResolve!: (value: string) => void;
  let bodyReject!: (error: Error) => void;
  const body = new Promise<string>((resolve, reject) => { bodyResolve = resolve; bodyReject = reject; });
  void body.catch(() => {});

  const cleanup = () => {
    clearTimeout(timeout);
    streamCallbacks.delete(reqId);
    options.signal?.removeEventListener('abort', onAbort);
    watcher.stop();
  };
  const fail = (error: Error) => {
    if (terminal) return;
    terminal = true;
    cleanup();
    metaReject(error);
    bodyReject(error);
    output.error(error);
  };
  const abort = (): Promise<void> => aborting ??= Promise.resolve().then(async () => {
    fail(new Error('Browser stream cancelled'));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await page.evaluate((id: string) => {
            (window as any).__abortControllers?.[id]?.abort();
          }, reqId);
          await evaluation;
        })(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Browser stream abort timed out')), Math.min(5000, config.timeouts.http));
        }),
      ]);
    } catch (error) {
      if (options.closeOnAbortTimeout && !page.isClosed()) await page.close();
      if (!page.isClosed()) throw error;
      await evaluation;
    } finally {
      clearTimeout(deadline);
      cleanup();
    }
  }).catch(error => { aborting = undefined; throw error; });
  const onAbort = () => { void abort().catch(() => {}); };
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      fail(new Error(`Browser stream fetch timed out after ${timeoutMs}ms`));
      void abort().catch(() => {});
    }, timeoutMs);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    cancel() { return abort(); },
  });
  streamCallbacks.set(reqId, {
    onMeta(meta) {
      clearTimeout(timeout);
      if (!meta.contentType.includes('text/event-stream')) armTimeout();
      metaResolve(meta);
    },
    onChunk(chunk) { if (!terminal) output.enqueue(enc.encode(chunk)); },
    onEnd() {
      if (terminal) return;
      terminal = true;
      cleanup();
      bodyResolve('');
      output.close();
    },
    onError(message) { fail(new Error(message)); },
    onBody(text) {
      if (terminal) return;
      terminal = true;
      cleanup();
      bodyResolve(text);
      output.close();
    },
  });
  armTimeout();
  const { signal: _signal, ...browserOptions } = options;
  evaluation = page.evaluate(async ({ url, options, reqId, evalTimeoutMs }: any) => {
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

      const responseContentType = resp.headers.get('content-type') || '';
      if (!resp.ok || !resp.body || !responseContentType.includes('text/event-stream')) {
        const bodyText = await resp.text().catch(() => '');
        (window as any).__streamRelay(reqId, 'body', bodyText);
        delete (window as any).__abortControllers[reqId];
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      // Coalesce chunks before crossing the CDP bridge. Each __streamRelay call
      // is an expensive serialized round-trip; batching by time/size reduces
      // bridge overhead. Thresholds tuned for LOW LATENCY: small byte budget +
      // short interval flush ~2-3 SSE events at a time, and the very first chunk
      // is flushed immediately for minimum first-token latency (TTFT).
      // NOTE: keep this inline (no named functions) — code inside page.evaluate
      // runs in the browser where esbuild's __name helper does not exist.
      const FLUSH_BYTES = 512;
      const FLUSH_INTERVAL_MS = 8;
      let pending = '';
      let flushTimer: any = null;
      let firstChunkSent = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            if (pending) { (window as any).__streamRelay(reqId, 'chunk', pending); pending = ''; }
            (window as any).__streamRelay(reqId, 'end', null);
            break;
          }
          pending += decoder.decode(value, { stream: true });
          if (!firstChunkSent) {
            // Fast-path: flush the first byte(s) immediately to minimize TTFT.
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            (window as any).__streamRelay(reqId, 'chunk', pending);
            pending = '';
            firstChunkSent = true;
          } else if (pending.length >= FLUSH_BYTES) {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            (window as any).__streamRelay(reqId, 'chunk', pending);
            pending = '';
          } else if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              if (pending) { (window as any).__streamRelay(reqId, 'chunk', pending); pending = ''; }
            }, FLUSH_INTERVAL_MS);
          }
        }
      } finally {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        reader.releaseLock();
      }
      delete (window as any).__abortControllers[reqId];
    } catch (e: any) {
      clearTimeout(timeoutId);
      (window as any).__streamRelay(reqId, 'error', e.message);
      delete (window as any).__abortControllers[reqId];
    }
  }, { url, options: browserOptions, reqId, evalTimeoutMs: timeoutMs }).then(() => {}, (error: Error) => { fail(error); });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const meta = await metadata;
    return { ...meta, stream, body: meta.contentType.includes('text/event-stream') ? '' : await body, reqId, abort };
  } catch (error) {
    await abort();
    throw error;
  } finally {
    watcher.stop();
  }
}
