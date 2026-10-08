import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cancel-'));
process.chdir(directory);
delete process.env.TEST_MOCK_PLAYWRIGHT;
process.env.QWEN_DIRECT_FETCH = 'true';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.WARM_POOL_SIZE = '0';
const { createQwenStream } = await import('../../services/stream-creator.js');
const { getAccountActiveLoad } = await import('../../core/account-manager.js');
const { closeDatabase } = await import('../../core/database.js');
const { chatCompletions, chatCompletionsStop } = await import('../../routes/chat.js');
const registry = await import('../../core/stream-registry.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });
const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture', 'bx-v': 'fixture' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test('consumer cancellation reaches the actual Node transport', { timeout: 10000 }, async t => {
  const closed = deferred();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: fixture\n\n');
    res.on('close', closed.resolve);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const nativeFetch = globalThis.fetch;
  const port = (server.address() as AddressInfo).port;
  t.mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit) => nativeFetch(`http://127.0.0.1:${port}`, init));
  try {
    const result = await createQwenStream('fixture', false, 'fixture-model', null, 'fixture-node', undefined, undefined,
      { chatId: 'fixture-chat', chatHeaders: headers });
    assert.equal(getAccountActiveLoad('fixture-node'), 1);
    await result.stream.cancel('consumer disconnected');
    await closed.promise;
    assert.equal(result.controller.signal.aborted, true);
    assert.equal(getAccountActiveLoad('fixture-node'), 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('account slot stays reserved until underlying cancellation finishes', async t => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { calls++; started.resolve(); return gate.promise; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const result = await createQwenStream('fixture', false, 'fixture-model', null, 'fixture-delayed', undefined, undefined,
    { chatId: 'fixture-chat', chatHeaders: headers });
  const cancelling = result.stream.cancel('disconnect');
  await started.promise;
  assert.equal(getAccountActiveLoad('fixture-delayed'), 1);
  result.controller.abort();
  gate.resolve();
  await cancelling;
  assert.equal(calls, 1);
  assert.equal(getAccountActiveLoad('fixture-delayed'), 0);
});

test('idle timeout ends a pending read and tears down exactly once', { timeout: 2000 }, async () => {
  const { manageQwenStream } = await import('../../services/stream-lifecycle.js');
  let cancelled = 0;
  let released = 0;
  const controller = new AbortController();
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const managed = manageQwenStream(source, controller, 20, 'fixture', undefined, () => { released++; }, () => {});
  await assert.rejects(managed.stream.getReader().read(), /idle timeout/);
  await managed.cancel();
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(controller.signal.aborted, true);
});

test('EOF and source failure both settle the lifecycle once', async () => {
  const { manageQwenStream } = await import('../../services/stream-lifecycle.js');
  for (const failed of [false, true]) {
    let released = 0;
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      start(stream) { if (failed) stream.error(new Error('fixture source failure')); else stream.close(); },
    });
    const managed = manageQwenStream(source, controller, 1000, 'fixture', undefined, () => { released++; }, () => {});
    if (failed) await assert.rejects(managed.stream.getReader().read(), /fixture source failure/);
    else assert.equal((await managed.stream.getReader().read()).done, true);
    await managed.cancel();
    assert.equal(released, 1);
    assert.equal(controller.signal.aborted, failed);
  }
});

test('an unconfirmed transport teardown does not release its lease', async () => {
  const { manageQwenStream } = await import('../../services/stream-lifecycle.js');
  let released = false;
  const managed = manageQwenStream(new ReadableStream<Uint8Array>(), new AbortController(), 1000, 'fixture',
    async () => { throw new Error('fixture teardown failed'); }, () => { released = true; }, () => {});
  await assert.rejects(managed.stream.cancel(), /fixture teardown failed/);
  assert.equal(released, false);
});

test('cancelling economical reuse keeps the persisted history incomplete', async t => {
  const { getSession, setSession } = await import('../../services/session-manager.js');
  setSession('fixture-reuse', { accountId: 'fixture-reuse', chatId: 'fixture-reuse-chat', headers,
    parentId: 'previous-response', historyComplete: true, updatedAt: Date.now() });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>(), {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  const result = await createQwenStream('bootstrap fixture', false, 'fixture-model', null, 'fixture-reuse', undefined, undefined,
    { sessionKey: 'fixture-reuse', economicalPrompt: 'User: next fixture' });
  assert.equal(result.uiSessionId, 'fixture-reuse-chat');
  await result.cancel('disconnect');
  assert.equal(getSession('fixture-reuse')?.historyComplete, false);
});

test('HTTP stop and client disconnect do not retry or confirm partial history', { timeout: 5000 }, async t => {
  const { addAccount } = await import('../../core/accounts.js');
  const { getSession } = await import('../../services/session-manager.js');
  addAccount('fixture@example.invalid', 'fixture-password', 'http-fixture');
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  const app = new Hono();
  app.post('/chat', chatCompletions);
  app.post('/stop', chatCompletionsStop);
  let posts = 0;
  let cancellations = 0;
  let continuationPosts = 0;
  let continuationMode = false;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/completions/stop')) return Response.json({ success: true });
    if (url.includes('/completions?')) {
      posts++;
      if (continuationMode) continuationPosts++;
      const initialContinuation = continuationMode && continuationPosts === 1;
      const responseId = continuationMode ? `continued-response-${continuationPosts}` : 'http-response';
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
            'response.created': { response_id: responseId },
            response_id: responseId, choices: [{ delta: { content: 'fixture '.repeat(150), phase: 'answer' },
              ...(initialContinuation ? { finish_reason: 'length' } : {}) }],
          }) + '\n\n'));
          if (initialContinuation) controller.close();
        },
        cancel() { cancellations++; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.includes('/settings/update')) return Response.json({ success: true });
    throw new Error('Unexpected network request in HTTP cancellation fixture');
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('HTTP cancellation fixture timed out');
      await new Promise(r => setTimeout(r, 5));
    }
  }
  try {
    for (const mode of ['stop', 'disconnect', 'non-streaming', 'continuation'] as const) {
      continuationMode = mode === 'continuation';
      const key = `http-${mode}`;
      const abort = new AbortController();
      const pending = app.request('/chat', { method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.7-plus', user: key, stream: mode === 'stop' || mode === 'disconnect',
          messages: [{ role: 'user', content: 'Produce a long fixture answer.' }] }),
      });
      await until(() => [...registry.getStreamRegistry().values()].some(entry =>
        entry.targetResponseId === (continuationMode ? 'continued-response-2' : 'http-response')));
      if (mode === 'non-streaming' || mode === 'continuation') {
        abort.abort(new Error('fixture client disconnected'));
        const response = await pending;
        assert.ok(response.status >= 400, 'A cancelled completion must not succeed');
      } else {
        const response = await pending;
        const reader = response.body!.getReader();
        await reader.read();
        if (mode === 'stop') {
          const stopped = await app.request('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completion_id: response.headers.get('X-Completion-Id'), stop_token: response.headers.get('X-Stop-Token') }),
          });
          assert.equal(stopped.status, 200);
          while (true) { if ((await reader.read()).done) break; }
        } else await reader.cancel('fixture client disconnected');
      }
      await until(() => registry.getStreamRegistry().size === 0);
      assert.equal(getAccountActiveLoad('http-fixture'), 0);
      assert.equal(getSession(key)?.historyComplete, false);
    }
    assert.equal(posts, 5);
    assert.equal(cancellations, 4);
  } finally {
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});
