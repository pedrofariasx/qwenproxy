import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-stop-'));
process.chdir(directory);
process.env.ADMIN_PASSWORD = 'fixture-admin';
const { chatCompletionsStop } = await import('../../routes/chat.js');
const registry = await import('../../core/stream-registry.js');
const { closeDatabase } = await import('../../core/database.js');
after(() => { closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); });
const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture', 'bx-v': 'fixture' };

test('stop resolves trusted upstream IDs and keeps local teardown independent of acknowledgement', async t => {
  const app = new Hono();
  app.post('/stop', chatCompletionsStop);
  const sent: { url: string; body: any }[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ success: status === 200 }, { status });
  });
  let cancelled = 0;
  function register(key = 'chatcmpl-fixture', chat = 'upstream-fixture', response = 'response-fixture') {
    registry.registerStream(key, {
      abortController: new AbortController(), accountId: 'fixture', uiSessionId: chat,
      targetResponseId: response, stopToken: 'fixture-stop-token', headers,
      cancel: async () => { cancelled++; },
    });
  }
  async function stop(body: Record<string, unknown>) {
    return app.request('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  const token = { stop_token: 'fixture-stop-token' };
  try {
    register();
    let response = await stop({ chat_id: 'chatcmpl-fixture', response_id: 'response-fixture', ...token });
    assert.equal(response.status, 200);
    assert.equal(new URL(sent[0].url).searchParams.get('chat_id'), 'upstream-fixture');
    assert.deepEqual(sent[0].body, { chat_id: 'upstream-fixture', response_id: 'response-fixture' });

    register();
    response = await stop({ chat_id: 'upstream-fixture', ...token });
    assert.equal(response.status, 200);
    register();
    response = await stop({ completion_id: 'chatcmpl-fixture', stop_token: 'wrong' });
    assert.equal(response.status, 403);
    response = await stop({ completion_id: 'chatcmpl-fixture', response_id: 'stale-response', ...token });
    assert.equal(response.status, 400);
    register('chatcmpl-second');
    response = await stop({ chat_id: 'upstream-fixture', ...token });
    assert.equal(response.status, 409);
    registry.removeStream('chatcmpl-second');

    register('chatcmpl-fixture', 'upstream-fixture', '');
    const count = sent.length;
    response = await stop({ completion_id: 'chatcmpl-fixture', ...token });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).upstream_stop_accepted, false);
    assert.equal(sent.length, count, 'Unknown response IDs must never be sent upstream');

    register();
    status = 503;
    response = await stop({ completion_id: 'chatcmpl-fixture', ...token });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).transport_stopped, true);
    assert.equal(registry.getStream('chatcmpl-fixture'), undefined);
    assert.equal(cancelled, 4);
  } finally {
    registry.removeStream('chatcmpl-fixture');
    registry.removeStream('chatcmpl-second');
  }
});

test('response metadata and delayed removal cannot overwrite a replacement stream', () => {
  const entry = { abortController: new AbortController(), accountId: 'fixture', uiSessionId: 'chat-a', targetResponseId: '', headers, stopToken: 'fixture' };
  registry.registerStream('fixture', entry);
  const old = registry.getStream('fixture')!;
  registry.updateStreamResponseId('fixture', 'chat-a', 'response-a');
  assert.equal(old.targetResponseId, 'response-a');
  registry.registerStream('fixture', { ...entry, uiSessionId: 'chat-b' });
  registry.updateStreamResponseId('fixture', 'chat-a', 'stale-response');
  registry.removeStream('fixture', old);
  assert.equal(registry.getStream('fixture')?.targetResponseId, '');
  registry.removeStream('fixture');
});

test('administrative stop waits for transport cleanup before reporting completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  registry.registerStream('admin-fixture', {
    abortController: new AbortController(), accountId: 'fixture', uiSessionId: 'fixture-chat',
    targetResponseId: '', headers, stopToken: 'fixture', cancel: () => gate,
  });
  let finished = false;
  const pending = registry.abortStream('admin-fixture').then(result => { finished = true; return result; });
  await new Promise(r => setImmediate(r));
  assert.equal(finished, false);
  assert.ok(registry.getStream('admin-fixture'));
  release();
  assert.equal(await pending, true);
  assert.equal(registry.getStream('admin-fixture'), undefined);
  assert.equal(await registry.abortStream('missing-fixture'), false);
});

test('administrative HTTP stop reports failed teardown and preserves the registered stream', async () => {
  const { adminApp } = await import('../../api/admin.js');
  const login = await adminApp.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-admin' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  registry.registerStream('admin-http-fixture', {
    abortController: new AbortController(), accountId: 'fixture', uiSessionId: 'fixture-chat',
    targetResponseId: '', headers, stopToken: 'fixture', cancel: async () => { throw new Error('fixture teardown failure'); },
  });
  try {
    const response = await adminApp.request('/api/streams/admin-http-fixture/stop', { method: 'POST', headers: { cookie } });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, transport_stopped: false, error: 'Transport teardown failed' });
    assert.ok(registry.getStream('admin-http-fixture'));
    registry.getStream('admin-http-fixture')!.cancel = async () => {};
    const retry = await adminApp.request('/api/streams/admin-http-fixture/stop', { method: 'POST', headers: { cookie } });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true });
    assert.equal(registry.getStream('admin-http-fixture'), undefined);
  } finally { registry.removeStream('admin-http-fixture'); }
});
