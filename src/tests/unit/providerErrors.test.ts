import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

Object.assign(process.env, { TEST_MOCK_PLAYWRIGHT: 'true', QWEN_DIRECT_FETCH: 'true', HYBRID_SESSION_VERIFY: 'false', WARM_POOL_SIZE: '0', AUTO_CONTINUE: 'false', BROWSER_IDLE_HIBERNATE_MS: '0', QWEN_PROVIDER_RETRY_DELAY_MS: '0' });
for (const key of ['API_KEY', 'AUTH_REQUIRED', 'USER_API_KEYS']) delete process.env[key];
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-provider-errors-'));
process.chdir(directory);
const { app } = await import('../../api/server.js');
const { handleStreamingResponse, collectNonStreamingResult } = await import('../../routes/stream-handler.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { clearAccountIsolation } = await import('../../core/account-isolation.js');
const { getAccountCooldownInfo, getAccountActiveLoad } = await import('../../core/account-manager.js');
const { registerStream, getStream } = await import('../../core/stream-registry.js');
const { getSession, resetAllSessions, setSession } = await import('../../services/session-manager.js');
const { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } = await import('../../tools/toolcall-tags.js');
const accounts = ['a', 'b', 'c'].map(name => addAccount(`provider-${name}@example.test`, 'fixture-password', `provider-${name}`));
const overloaded = { code: 'quota_limit', details: 'O serviço está com alta demanda no momento. Tente novamente mais tarde.' };
const daily = { code: 'quota_limit', details: "You've reached today's chat limit. Try again tomorrow." };
const ordinary = 'ROUTED_OK';
beforeEach(() => { resetAllSessions(); for (const account of accounts) clearAccountIsolation(account.id); });
after(() => { closeDatabase(); process.chdir(originalCwd); fs.rmSync(directory, { recursive: true, force: true }); });

function upstream(rows: any[], close = true, newline = true, onCancel?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(rows.map(row => `data: ${JSON.stringify(row)}`).join('\n\n') + (newline ? '\n\n' : '')));
    if (close) controller.close();
    else timer = setTimeout(() => controller.close(), 1000);
  }, cancel() { clearTimeout(timer); onCancel?.(); } });
}
function answer(content: string, id = 'selected') { return { response_id: id, choices: [{ delta: { phase: 'answer', content } }] }; }
function chunks(text: string) { return text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))); }

for (const streaming of [false, true]) {
  for (const scenario of ['structured-recovery', 'history-recovery', 'foreign-history-error', 'repeated-overload', 'unknown-error', 'daily-error'] as const) {
    test(`${streaming ? 'SSE' : 'JSON'} handles ${scenario} with bounded recovery and correct account state`, async () => {
      const originalFetch = globalThis.fetch;
      let posts = 0;
      let histories = 0;
      globalThis.fetch = async input => {
        if (String(input).includes('/api/v2/chats/')) {
          histories++;
          return new Response(JSON.stringify({ success: true, data: { chat: { messages: [{ id: scenario === 'foreign-history-error' ? 'unselected-parent' : 'reply-1', role: 'assistant', content: '', error: scenario === 'foreign-history-error' ? daily : overloaded }] } } }));
        }
        posts++;
        const error = scenario === 'daily-error' ? daily : scenario === 'unknown-error' ? { code: 'quota_limit', details: 'Opaque provider condition' } : overloaded;
        const rows: any[] = [{ 'response.created': { response_id: `reply-${posts}` } }];
        if (posts > 1 && scenario !== 'repeated-overload') rows.push(answer(ordinary, `reply-${posts}`));
        else if (scenario !== 'history-recovery' && scenario !== 'foreign-history-error') rows.push({ response_id: `reply-${posts}`, error });
        return new Response(upstream(rows), { headers: { 'content-type': 'text/event-stream' } });
      };
      try {
        const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.6-plus', user: 'provider-route', messages: [{ role: 'user', content: 'Return the fixture.' }], stream: streaming }) }));
        const raw = await response.text();
        const rows = streaming ? chunks(raw) : [JSON.parse(raw)];
        const error = rows.find(row => row.error)?.error;
        if (scenario === 'repeated-overload' || scenario === 'unknown-error') {
          assert.equal(response.status, streaming ? 200 : scenario === 'repeated-overload' ? 503 : 502);
          assert.equal(error?.code, scenario === 'repeated-overload' ? 'UpstreamOverloaded' : 'UpstreamError');
          assert.equal(getSession('provider-route')?.historyComplete, false);
          if (!streaming && scenario === 'repeated-overload') assert.equal(response.headers.get('retry-after'), '2');
        } else {
          assert.equal(response.status, 200);
          assert.equal(error, undefined);
          assert.equal(streaming ? rows.map(row => row.choices?.[0]?.delta?.content || '').join('') : rows[0].choices[0].message.content, ordinary);
          assert.equal(getSession('provider-route')?.historyComplete, true);
          assert.equal(response.headers.get('retry-after'), null, 'a recovered success must not inherit the failed attempt header');
        }
        assert.equal(posts, scenario === 'unknown-error' ? 1 : 2);
        assert.equal(histories, scenario === 'history-recovery' || scenario === 'foreign-history-error' ? 1 : 0);
        if (streaming) assert.equal((raw.match(/data: \[DONE\]/g) || []).length, 1);
        assert.equal(accounts.filter(account => getAccountCooldownInfo(account.id)).length, scenario === 'daily-error' ? 1 : 0, 'temporary demand must not quarantine accounts as exhausted');
        for (const account of accounts) assert.equal(getAccountActiveLoad(account.id), 0);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}

async function direct(rows: any[], options: any = {}, source = upstream(rows)) {
  registerStream('provider-direct', { abortController: new AbortController(), accountId: accounts[0].id, uiSessionId: 'provider-chat', targetResponseId: '', headers: {}, stopToken: 'fixture' });
  setSession('provider-direct-session', { chatId: 'provider-chat', accountId: accounts[0].id, headers: {}, parentId: null, historyComplete: true, updatedAt: Date.now() });
  let completed = 0;
  let failedUsage = false;
  const server = new Hono();
  server.get('/', c => handleStreamingResponse(c, { stream: source, completionId: 'provider-direct', model: 'qwen3.6-plus', uiSessionId: 'provider-chat', hasTools: false, tools: [], finalPrompt: 'Fixture', onComplete: () => { completed++; }, onUsage: (_p: number, _c: number, failed?: boolean) => { failedUsage = !!failed; }, ...options }));
  const response = await server.request('/');
  const raw = await response.text();
  assert.equal(completed, 1);
  assert.equal(getStream('provider-direct'), undefined);
  return { rows: chunks(raw), raw, failedUsage };
}

for (const kind of ['content', 'reasoning', 'tool'] as const) {
  test(`SSE error after ${kind} preserves emitted output and does not replay`, async () => {
    let retries = 0;
    const first = kind === 'reasoning' ? { choices: [{ delta: { phase: 'think', content: 'Reasoning already emitted.' } }] } : answer(kind === 'tool' ? `${TOOL_CALL_OPEN}{"name":"echo","arguments":{}}${TOOL_CALL_CLOSE}` : 'Partial response already emitted.');
    const result = await direct([first, { error: overloaded }], { hasTools: kind === 'tool', tools: kind === 'tool' ? [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }] : [], onProviderRetry: async () => { retries++; return null; } });
    assert.equal(retries, 0);
    assert.equal(result.rows.find(row => row.error)?.error.code, 'UpstreamOverloaded');
    assert.equal(result.failedUsage, true);
    assert.equal(getSession('provider-direct-session')?.historyComplete, false);
    if (kind === 'content') assert.equal(result.rows.map(row => row.choices?.[0]?.delta?.content || '').join(''), 'Partial response already emitted.');
    if (kind === 'reasoning') assert.ok(result.rows.some(row => row.choices?.[0]?.delta?.reasoning_content === 'Reasoning already emitted.'));
    if (kind === 'tool') assert.equal(result.rows.flatMap(row => row.choices?.[0]?.delta?.tool_calls || []).length, 1);
    assert.equal((result.raw.match(/data: \[DONE\]/g) || []).length, 1);
  });
}

for (const streaming of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} accepts a final error event without a trailing newline`, async () => {
    const source = upstream([{ error: overloaded }], true, false);
    if (streaming) assert.equal((await direct([], {}, source)).rows.find(row => row.error)?.error.code, 'UpstreamOverloaded');
    else {
      const server = new Hono();
      server.get('/', async c => { const value = await collectNonStreamingResult(c, source, 'missing', 'qwen3.6-plus', 'missing-chat', false, []); return c.json(value.body, value.status as any); });
      assert.equal((await server.request('/')).status, 503);
    }
  });
  test(`${streaming ? 'SSE' : 'JSON'} ignores an error belonging to an alternate response`, async () => {
    const rows = [{ 'response.created': { response_id: 'selected' } }, { response_id: 'other', error: overloaded }, answer(ordinary)];
    if (streaming) assert.equal((await direct(rows)).rows.map(row => row.choices?.[0]?.delta?.content || '').join(''), ordinary);
    else {
      const value = await collectNonStreamingResult({} as any, upstream(rows), 'missing', 'qwen3.6-plus', 'missing-chat', false, []);
      assert.equal(value.status, 200); assert.equal(value.content, ordinary);
    }
  });
}

test('SSE stops an error stream that never closes and releases it once', async () => {
  let cancelled = 0;
  const result = await direct([], {}, upstream([{ error: overloaded }], false, true, () => { cancelled++; }));
  assert.equal(cancelled, 1);
  assert.equal(result.rows.find(row => row.error)?.error.code, 'UpstreamOverloaded');
});

test('JSON read failure releases its reader, registry and completion callback', async () => {
  const source = new ReadableStream({ start(controller) { controller.error(new Error('Fixture broken read')); } });
  registerStream('broken-json', { abortController: new AbortController(), accountId: accounts[0].id, uiSessionId: 'broken-json-chat', targetResponseId: '', headers: {}, stopToken: 'fixture' });
  let completed = 0;
  await assert.rejects(collectNonStreamingResult({} as any, source, 'broken-json', 'qwen3.6-plus', 'broken-json-chat', false, [], () => { completed++; }));
  assert.equal(source.locked, false);
  assert.equal(getStream('broken-json'), undefined);
  assert.equal(completed, 1);
});

test('SSE handles valid data fields without an optional space', async () => {
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data:${JSON.stringify({ error: overloaded })}\n\n`)); controller.close(); } });
  assert.equal((await direct([], {}, source)).rows.find(row => row.error)?.error.code, 'UpstreamOverloaded');
});

for (const streaming of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} normalizes a multiline non-SSE error body`, async () => {
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ success: false, data: overloaded }, null, 2) + '\n')); controller.close(); } });
    if (streaming) assert.equal((await direct([], {}, source)).rows.find(row => row.error)?.error.code, 'UpstreamOverloaded');
    else {
      const server = new Hono();
      server.get('/', async c => { const value = await collectNonStreamingResult(c, source, 'missing', 'qwen3.6-plus', 'missing-chat', false, []); return c.json(value.body, value.status as any); });
      assert.equal((await server.request('/')).status, 503);
    }
  });
}

test('SSE abort during history lookup cancels the lookup and releases completion', async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  let historyStarted!: () => void;
  const started = new Promise<void>(resolve => { historyStarted = resolve; });
  let lookupAborted = false;
  let completed = 0;
  globalThis.fetch = async (_input, init) => {
    historyStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { lookupAborted = true; reject(new DOMException('Fixture cancelled', 'AbortError')); }, { once: true });
    });
  };
  registerStream('abort-history', { abortController: new AbortController(), accountId: accounts[0].id, uiSessionId: 'abort-chat', targetResponseId: '', headers: {}, stopToken: 'fixture' });
  setSession('abort-history-session', { chatId: 'abort-chat', accountId: accounts[0].id, headers: {}, parentId: null, historyComplete: true, updatedAt: Date.now() });
  const server = new Hono();
  server.get('/', c => handleStreamingResponse(c, { stream: upstream([{ 'response.created': { response_id: 'empty-parent' } }]), completionId: 'abort-history', model: 'qwen3.6-plus', uiSessionId: 'abort-chat', hasTools: false, tools: [], finalPrompt: 'Fixture', onComplete: () => { completed++; } }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await server.fetch(new Request('http://localhost/', { signal: abort.signal }));
    const body = response.text();
    await Promise.race([started, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('History lookup did not start')), 1000); })]);
    abort.abort();
    await body;
    assert.equal(lookupAborted, true);
    assert.equal(completed, 1);
    assert.equal(getStream('abort-history'), undefined);
    assert.equal(getSession('abort-history-session')?.historyComplete, false);
  } finally { clearTimeout(deadline); abort.abort(); globalThis.fetch = originalFetch; }
});

test('aborting browser history navigation closes only the isolated page', async () => {
  const { config } = await import('../../core/config.js');
  const { accountPages } = await import('../../services/browser-manager.js');
  const { fetchQwenChatHistory } = await import('../../services/qwen.js');
  const previous = config.directFetch.enabled;
  config.directFetch.enabled = false;
  const abort = new AbortController();
  let started!: () => void;
  const navigation = new Promise<void>(resolve => { started = resolve; });
  let rejectNavigation!: (error: Error) => void;
  let closed = 0;
  const isolated = { goto: async () => { started(); await new Promise((_resolve, reject) => { rejectNavigation = reject; }); }, close: async () => { closed++; rejectNavigation(new Error('Fixture page closed')); } };
  const parent = { isClosed: () => false, url: () => 'https://chat.qwen.ai/', context: () => ({ newPage: async () => isolated }) };
  accountPages.set('browser-abort-fixture', parent as any);
  try {
    const lookup = fetchQwenChatHistory('fixture-chat', {}, 'browser-abort-fixture', 10, abort.signal);
    await navigation;
    abort.abort();
    assert.equal((await lookup).hasHistory, false);
    assert.equal(closed, 1);
    assert.equal(accountPages.get('browser-abort-fixture'), parent);
  } finally { abort.abort(); config.directFetch.enabled = previous; accountPages.delete('browser-abort-fixture'); }
});

test('a cancelled JSON request does not mark its pinned history complete', async () => {
  const abort = new AbortController();
  abort.abort();
  setSession('cancelled-json-session', { chatId: 'cancelled-chat', accountId: accounts[0].id, headers: {}, parentId: null, historyComplete: false, updatedAt: Date.now() });
  await collectNonStreamingResult({ req: { raw: { signal: abort.signal } } } as any, upstream([answer(ordinary)]), 'cancelled-json', 'qwen3.6-plus', 'cancelled-chat', false, []);
  assert.equal(getSession('cancelled-json-session')?.historyComplete, false);
});
