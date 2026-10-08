import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

delete process.env.TEST_MOCK_PLAYWRIGHT;
process.env.QWEN_DIRECT_FETCH = 'false';
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-header-capture-'));
process.chdir(directory);
const { config } = await import('../../core/config.js');
const { closeDatabase } = await import('../../core/database.js');
const { getGuestHeaders, getQwenHeaders } = await import('../../services/header-interceptor.js');
const { accountPages, accountHeaderCaches, getAccountHeaderCache, getUiMutex, setBrowser, setGuestPage, setGuestContext, setGuestHeadersCache, getGuestHeadersCache } = await import('../../services/browser-manager.js');
const { isAccountReady, markAccountNotReady } = await import('../../core/account-manager.js');
await import('../../services/qwen.js');
setBrowser({ isConnected: () => true, newContext: async () => { throw new Error('Unexpected browser context in isolated header test'); } } as unknown as Browser);

after(() => {
  setBrowser(null);
  closeDatabase();
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
});

const fixtureHeaders = {
  cookie: 'fixture-cookie',
  'bx-ua': 'fixture-bx-ua',
  'bx-umidtoken': 'fixture-bx-umidtoken',
  'bx-v': 'fixture-bx-v',
  'user-agent': 'fixture-user-agent',
  'x-request-id': 'fixture-request',
};
const pattern = '**/api/v2/chat/completions*';

type RouteHandler = (route: unknown, request: unknown) => Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

for (const mode of ['guest', 'account'] as const) {
  for (const scenario of ['timeout-pending-cleanup', 'timeout-completed-cleanup', 'timeout-header-error', 'ui-error', 'duplicate'] as const) {
    test(`${mode} ignores late header results after ${scenario}`, { timeout: 2000 }, async t => {
      const accountId = `late-header-fixture-${mode}-${scenario}`;
      const originalTimeout = config.timeouts.headers;
      config.timeouts.headers = 1000;
      const originalSetTimeout = globalThis.setTimeout;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let fireTimeout!: () => void | Promise<void>;
      t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const isCaptureTimeout = delay === config.timeouts.headers;
        if (isCaptureTimeout) fireTimeout = () => callback(...args);
        const timer = originalSetTimeout(isCaptureTimeout ? () => undefined : callback, isCaptureTimeout ? 60000 : delay, ...args);
        timer.unref();
        timers.add(timer);
        return timer;
      });
      const headers = deferred<Record<string, string>>();
      const started = deferred<void>();
      const cleanupStarted = deferred<void>();
      const cleanup = deferred<void>();
      const failure = new Error('Fixture UI setup failed');
      const lateHeaders = { ...fixtureHeaders, cookie: 'late-fixture-cookie', 'bx-ua': 'late-fixture-bx-ua' };
      const tasks: Promise<void>[] = [];
      let continues = 0;
      let aborts = 0;
      let handler: RouteHandler | undefined;
      const route = { continue: async () => { continues++; }, abort: async () => { aborts++; } };
      const request = {
        allHeaders: () => { started.resolve(); return headers.promise; },
        url: () => 'https://chat.qwen.ai/api/v2/chat/completions',
        postData: () => JSON.stringify({ chat_id: 'late-fixture-chat' }),
      };
      const page = {
        isClosed: () => true,
        url: () => 'https://chat.qwen.ai/c/new-chat',
        $: async () => null,
        locator: () => ({ count: async () => 0 }),
        waitForSelector: async () => { if (scenario === 'ui-error') throw failure; await new Promise(() => {}); },
        screenshot: async () => { cleanupStarted.resolve(); await cleanup.promise; },
        evaluate: async () => ({ status: 200, body: '{"success":true}' }),
        route: async (registeredPattern: string, callback: RouteHandler) => {
          assert.equal(registeredPattern, pattern);
          handler = callback;
          if (scenario === 'duplicate') tasks.push(callback(route, { ...request, allHeaders: async () => fixtureHeaders }));
          tasks.push(callback(route, request));
        },
        unroute: async (registeredPattern: string, callback: RouteHandler) => {
          assert.equal(registeredPattern, pattern);
          assert.equal(callback, handler);
        },
      } as unknown as Page;
      setGuestHeadersCache(null);
      if (mode === 'guest') {
        setGuestPage(page);
        setGuestContext({ close: async () => { cleanupStarted.resolve(); await cleanup.promise; } } as unknown as BrowserContext);
      } else accountPages.set(accountId, page);
      const cache = getAccountHeaderCache(accountId);
      const outcome = (mode === 'guest' ? getGuestHeaders() : getQwenHeaders(true, accountId))
        .then(value => ({ kind: 'success' as const, value }), error => ({ kind: 'error' as const, error }));
      try {
        await started.promise;
        if (scenario.startsWith('timeout')) {
          void fireTimeout();
          await cleanupStarted.promise;
          if (scenario === 'timeout-completed-cleanup') {
            cleanup.resolve();
            assert.equal((await outcome).kind, 'error');
          }
        } else {
          const result = await outcome;
          assert.equal(result.kind, scenario === 'duplicate' ? 'success' : 'error');
          if (result.kind === 'error') assert.equal(result.error, failure);
        }
        if (scenario === 'timeout-header-error') headers.reject(new Error('Fixture late allHeaders failure'));
        else headers.resolve(lateHeaders);
        await Promise.all(tasks);
        if (scenario === 'duplicate') {
          assert.equal(mode === 'guest' ? getGuestHeadersCache()?.headers.cookie : cache.cachedQwenHeaders?.headers.cookie, fixtureHeaders.cookie);
          assert.equal(aborts, 1, 'only the winning capture may abort its request');
        } else {
          assert.equal(getGuestHeadersCache(), null);
          assert.equal(cache.cachedQwenHeaders, null);
          assert.deepEqual(cache.currentHeaders, {});
          assert.equal(isAccountReady(accountId), false);
          assert.equal(aborts, 0);
        }
        assert.equal(continues, 1, 'late requests must continue without applying their headers');
        cleanup.resolve();
        await outcome;
        if (mode === 'account') assert.equal(getUiMutex(accountId).isLocked(), false);
      } finally {
        headers.resolve(lateHeaders);
        cleanup.resolve();
        await Promise.all(tasks);
        await outcome;
        for (const timer of timers) clearTimeout(timer);
        config.timeouts.headers = originalTimeout;
        setGuestPage(null);
        setGuestContext(null);
        setGuestHeadersCache(null);
        accountPages.delete(accountId);
        accountHeaderCaches.delete(accountId);
        markAccountNotReady(accountId);
      }
    });
  }
}

for (const mode of ['guest', 'account'] as const) {
  for (const scenario of ['header-error', 'cleanup-error', 'success'] as const) {
    test(`${mode} header capture ${scenario} settles and releases the route`, async t => {
      const accountId = `header-fixture-${mode}-${scenario}`;
      const originalTimeout = config.timeouts.headers;
      config.timeouts.headers = 1000;
      const originalSetTimeout = globalThis.setTimeout;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const headerTimers = new Set<ReturnType<typeof setTimeout>>();
      const clearedTimers = new Set<ReturnType<typeof setTimeout>>();
      const originalClearTimeout = globalThis.clearTimeout;
      t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
        if (timer && typeof timer === 'object') clearedTimers.add(timer);
        originalClearTimeout(timer);
      });
      t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const timer = originalSetTimeout(callback, delay, ...args);
        timers.add(timer);
        if (delay === config.timeouts.headers) headerTimers.add(timer);
        return timer;
      });
      const failure = new Error('Fixture allHeaders failure');
      let failHeaders = scenario !== 'success';
      let continues = 0;
      let aborts = 0;
      let unroutes = 0;
      let screenshots = 0;
      let handler: RouteHandler | undefined;
      let handlerTask: Promise<void> | undefined;
      let handlerError: unknown;
      const route = {
        continue: async () => { continues++; if (scenario === 'cleanup-error') throw new Error('Fixture continue failure'); },
        abort: async () => { aborts++; },
      };
      const request = {
        allHeaders: async () => { if (failHeaders) throw failure; return fixtureHeaders; },
        url: () => 'https://chat.qwen.ai/api/v2/chat/completions',
        postData: () => JSON.stringify({ chat_id: 'fixture-chat', parent_id: 'fixture-parent' }),
      };
      const page = {
        isClosed: () => true,
        url: () => 'https://chat.qwen.ai/c/new-chat',
        $: async () => null,
        locator: () => ({ count: async () => 0 }),
        waitForSelector: () => new Promise(() => {}),
        evaluate: async () => ({ status: 200, body: '{"success":true}' }),
        screenshot: async () => { screenshots++; },
        route: async (registeredPattern: string, callback: RouteHandler) => {
          assert.equal(registeredPattern, pattern);
          handler = callback;
          handlerTask = callback(route, request).catch(error => { handlerError = error; });
        },
        unroute: async (registeredPattern: string, callback: RouteHandler) => {
          unroutes++;
          assert.equal(registeredPattern, pattern);
          assert.equal(callback, handler);
          if (scenario === 'cleanup-error') throw new Error('Fixture unroute failure');
        },
      } as unknown as Page;
      const capture = async () => mode === 'guest' ? getGuestHeaders() : (await getQwenHeaders(true, accountId)).headers;
      setGuestHeadersCache(null);
      if (mode === 'guest') setGuestPage(page);
      else accountPages.set(accountId, page);
      try {
        const outcome = await Promise.race([
          capture().then(value => ({ kind: 'success' as const, value }), error => ({ kind: 'error' as const, error })),
          new Promise<{ kind: 'deadline' }>(resolve => setTimeout(() => resolve({ kind: 'deadline' }), 100)),
        ]);
        assert.notEqual(outcome.kind, 'deadline', 'capture must settle before the header timeout');
        await handlerTask;
        assert.equal(handlerError, undefined, 'route callback must not leak its rejection');
        if (scenario === 'success') {
          assert.equal(outcome.kind, 'success');
          if (outcome.kind === 'success') {
            for (const name of ['cookie', 'bx-ua', 'bx-umidtoken', 'bx-v', 'user-agent'] as const) assert.equal(outcome.value[name], fixtureHeaders[name]);
          }
          assert.equal(aborts, 1);
          assert.equal(continues, 0);
          assert.equal(unroutes, 1);
        } else {
          assert.equal(outcome.kind, 'error');
          if (outcome.kind === 'error') assert.equal(outcome.error, failure, 'cleanup failures must preserve the original header error');
          assert.equal(continues, 1);
          assert.equal(aborts, 0);
          assert.equal(unroutes, 1);
          if (mode === 'guest') assert.equal(getGuestHeadersCache(), null);
          else {
            assert.equal(getUiMutex(accountId).isLocked(), false);
            assert.equal(getAccountHeaderCache(accountId).cachedQwenHeaders, null);
            assert.equal(isAccountReady(accountId), false);
          }
          if (scenario === 'header-error') {
            failHeaders = false;
            const recovered = await capture();
            assert.equal(recovered.cookie, fixtureHeaders.cookie);
            assert.equal(aborts, 1);
            assert.equal(unroutes, 2);
          }
        }
        for (const timer of headerTimers) assert.ok(clearedTimers.has(timer), 'capture must cancel its header timeout');
        assert.equal(screenshots, 0, 'failed header retrieval must not wait for the timeout callback');
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally {
        for (const timer of timers) clearTimeout(timer);
        config.timeouts.headers = originalTimeout;
        setGuestPage(null);
        setGuestHeadersCache(null);
        accountPages.delete(accountId);
        accountHeaderCaches.delete(accountId);
        markAccountNotReady(accountId);
      }
    });
  }
}
