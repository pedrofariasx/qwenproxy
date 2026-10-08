import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-browser-cancel-'));
process.chdir(directory);
delete process.env.TEST_MOCK_PLAYWRIGHT;
process.env.QWEN_DIRECT_FETCH = 'false';
process.env.WARM_POOL_SIZE = '0';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
const { createQwenStream } = await import('../../services/stream-creator.js');
const { browserStreamFetch } = await import('../../services/stream-bridge.js');
const { accountPages } = await import('../../services/browser-manager.js');
const { getAccountActiveLoad } = await import('../../core/account-manager.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });
const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture', 'bx-v': 'fixture' };

test('actual browser relay tears down requests without affecting adjacent streams', { timeout: 30000 }, async t => {
  const responses = new Map<string, http.ServerResponse>();
  const closed = new Set<string>();
  let firstChunk = true;
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      const id = body ? JSON.parse(body).chat_id : req.url!;
      responses.set(id, res);
      res.on('close', () => { closed.add(id); });
      if (id.startsWith('/pending') || id === 'pending-create') return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      if (firstChunk) res.write('data: fixture\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.grantPermissions(['local-network-access'], { origin: 'https://chat.qwen.ai' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.href === 'https://chat.qwen.ai/' || url.href === 'https://chat.qwen.ai/c/new-chat') return route.fulfill({ contentType: 'text/html', body: '<html>fixture</html>' });
    return route.abort();
  });
  await context.addInitScript(`const fixtureFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = String(input);
      return fixtureFetch(url.startsWith('https://chat.qwen.ai/api/v2/chat/completions') ? ${JSON.stringify(origin)} + '/completion' : input, init);
    };`);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected Node-side network request'); });
  const baseA = await context.newPage();
  const baseB = await context.newPage();
  await baseA.goto('https://chat.qwen.ai/');
  await baseB.goto('https://chat.qwen.ai/');
  accountPages.set('browser-a', baseA);
  accountPages.set('browser-b', baseB);
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Browser fixture condition timed out');
      await new Promise(r => setTimeout(r, 10));
    }
  }
  async function create(chat: string, account = 'browser-a', signal?: AbortSignal) {
    return createQwenStream('fixture', false, 'fixture-model', null, account, undefined, undefined,
      { chatId: chat, chatHeaders: headers, signal });
  }
  try {
    await t.test('controller abort ends pending read and preserves a second account', async () => {
      const first = await create('first');
      const second = await create('second', 'browser-b');
      assert.deepEqual(context.pages().filter(page => page !== baseA && page !== baseB).map(page => page.url()),
        ['https://chat.qwen.ai/c/new-chat', 'https://chat.qwen.ai/c/new-chat']);
      const firstReader = first.stream.getReader();
      const secondReader = second.stream.getReader();
      await firstReader.read();
      await secondReader.read();
      const pending = firstReader.read();
      first.controller.abort(new Error('fixture abort'));
      await assert.rejects(pending, /fixture abort/);
      await until(() => closed.has('first'));
      assert.equal(getAccountActiveLoad('browser-a'), 0);
      assert.equal(getAccountActiveLoad('browser-b'), 1);
      assert.equal(baseA.isClosed(), false);
      assert.equal(baseB.isClosed(), false);
      responses.get('second')!.write('data: still running\n\n');
      assert.match(new TextDecoder().decode((await secondReader.read()).value), /still running/);
      await secondReader.cancel();
      await until(() => closed.has('second'));
      assert.equal(getAccountActiveLoad('browser-b'), 0);
    });

    await t.test('consumer cancellation before the first chunk', async () => {
      firstChunk = false;
      const result = await create('no-chunk');
      await result.stream.cancel('disconnect');
      await until(() => closed.has('no-chunk'));
      assert.equal(result.controller.signal.aborted, true);
      assert.equal(getAccountActiveLoad('browser-a'), 0);
      assert.equal(baseA.isClosed(), false);
    });

    await t.test('signal abort before response metadata', async () => {
      const abort = new AbortController();
      const pending = browserStreamFetch(baseA, `${origin}/pending-abort`, { timeoutMs: 3000, signal: abort.signal });
      await until(() => responses.has('/pending-abort'));
      abort.abort();
      await assert.rejects(pending, /cancelled/);
      await until(() => closed.has('/pending-abort'));
      assert.equal(baseA.isClosed(), false);
    });

    await t.test('request abort during createQwenStream metadata wait releases the lease', async () => {
      const abort = new AbortController();
      const pending = create('pending-create', 'browser-a', abort.signal);
      await until(() => responses.has('pending-create'));
      assert.equal(getAccountActiveLoad('browser-a'), 1);
      abort.abort();
      await assert.rejects(pending, /cancelled/);
      await until(() => closed.has('pending-create'));
      assert.equal(getAccountActiveLoad('browser-a'), 0);
      assert.equal(baseA.isClosed(), false);
    });

    await t.test('metadata timeout cancels the actual browser fetch', async () => {
      await assert.rejects(browserStreamFetch(baseA, `${origin}/pending-timeout`, { timeoutMs: 100 }), /timed out/);
      await until(() => closed.has('/pending-timeout'));
      assert.equal(baseA.isClosed(), false);
    });

    await t.test('page loss rejects pending reads and releases the account', async () => {
      const result = await create('page-loss');
      const pending = result.stream.getReader().read();
      const owned = context.pages().find(page => page !== baseA && page !== baseB)!;
      assert.ok(owned);
      await owned.close();
      await assert.rejects(pending);
      assert.equal(getAccountActiveLoad('browser-a'), 0);
      assert.equal(baseA.isClosed(), false);
    });

    await t.test('abort deadline closes only the owned completion page', async () => {
      const result = await create('abort-deadline');
      const owned = context.pages().find(page => page !== baseA && page !== baseB)!;
      await owned.evaluate('for (const controller of Object.values(window.__abortControllers)) controller.abort = function() {};');
      await result.cancel('fixture abort deadline');
      await until(() => closed.has('abort-deadline'));
      assert.equal(owned.isClosed(), true);
      assert.equal(baseA.isClosed(), false);
      assert.equal(baseB.isClosed(), false);
      assert.equal(getAccountActiveLoad('browser-a'), 0);
    });

    await t.test('normal EOF cleans up without turning completion into an abort', async () => {
      const result = await create('normal-eof');
      responses.get('normal-eof')!.end('data: fixture\n\n');
      assert.equal(await new Response(result.stream).text(), 'data: fixture\n\n');
      assert.equal(result.controller.signal.aborted, false);
      assert.equal(getAccountActiveLoad('browser-a'), 0);
      assert.equal(context.pages().length, 3);
      const idle = context.pages().find(page => page !== baseA && page !== baseB)!;
      const reused = await create('reused-page');
      assert.equal(context.pages().length, 3);
      assert.equal(context.pages().find(page => page !== baseA && page !== baseB), idle);
      await reused.cancel('fixture stop on reused page');
      assert.equal(idle.isClosed(), true);
      assert.equal(context.pages().length, 2);
    });
  } finally {
    accountPages.delete('browser-a');
    accountPages.delete('browser-b');
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
