import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { isDailyQuotaAssistantMessage, couldBeDailyQuotaAssistantMessagePrefix } from '../../utils/qwen-quota-message.js';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.WARM_POOL_SIZE = '0';
process.env.AUTO_CONTINUE = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
delete process.env.API_KEY;
delete process.env.AUTH_REQUIRED;
delete process.env.USER_API_KEYS;
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-quota-'));
process.chdir(directory);
const { app } = await import('../../api/server.js');
const { handleStreamingResponse, collectNonStreamingResult } = await import('../../routes/stream-handler.js');
const { registerStream, removeStream, getStream } = await import('../../core/stream-registry.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { getInUseAccounts, getAccountCooldownInfo, getAccountActiveLoad, releaseAccountInUse } = await import('../../core/account-manager.js');
const { clearAccountIsolation } = await import('../../core/account-isolation.js');
const { setSession, getSession, resetAllSessions } = await import('../../services/session-manager.js');
const { config } = await import('../../core/config.js');
const accounts = ['first', 'second', 'third'].map(name => addAccount(`${name}@example.test`, 'fixture-password', `quota-${name}`));
const english = "You've reached today's chat limit. Try again tomorrow.";
const portuguese = 'Você atingiu seu limite diário de chats. Tente novamente amanhã.';
const ordinary = 'Normal answer after account rotation.';

beforeEach(() => {
  resetAllSessions();
  for (const account of accounts) {
    clearAccountIsolation(account.id);
    releaseAccountInUse(account.id);
  }
});
after(() => {
  closeDatabase();
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
});

function register(id: string, accountId: string) {
  registerStream(id, { abortController: new AbortController(), accountId, uiSessionId: `${id}-chat`, targetResponseId: '', headers: {}, stopToken: 'fixture-stop' });
}
function upstream(content: string | string[], id = 'quota-response', cached = 0) {
  const parts = Array.isArray(content) ? content : [content];
  const chunks = [JSON.stringify({ 'response.created': { response_id: id } }), ...parts.map(text => JSON.stringify({ response_id: id, choices: [{ delta: { phase: 'answer', content: text } }], usage: { input_tokens: 200, output_tokens: 8, prompt_tokens_details: { cached_tokens: cached } } })), '[DONE]'];
  return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`)); controller.close(); } });
}
function parsed(text: string) {
  const chunks = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
  return { chunks, content: chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join(''), done: (text.match(/data: \[DONE\]/g) || []).length };
}
async function streamResult(content: string | string[], extra: any = {}) {
  const id = 'quota-helper';
  register(id, accounts[0].id);
  let completed = 0;
  const server = new Hono();
  server.get('/', c => handleStreamingResponse(c, { stream: upstream(content), completionId: id, model: 'qwen3.8-max', uiSessionId: `${id}-chat`, hasTools: false, tools: [], finalPrompt: 'Fixture prompt', streamOptions: { include_usage: true }, onComplete: () => { completed++; }, ...extra }));
  try {
    const response = await server.request('/');
    const text = await response.text();
    return { ...parsed(text), text, completed, registryRemoved: getStream(id) === undefined };
  } finally { removeStream(id); }
}

test('quota notices require a short anchored EN/PT daily limit and tomorrow instruction', () => {
  for (const text of [english, portuguese, 'Your daily conversation limit has been reached. Come back tomorrow.', 'Você atingiu o limite de chats de hoje. Tente novamente amanhã.']) assert.equal(isDailyQuotaAssistantMessage(text), true);
  for (const text of ['', ordinary, 'If you have reached your daily chat limit, please try again tomorrow.', `"${english}" is an example.`, `> ${portuguese}`, 'The service may say: '+english, english+' extra explanation'.repeat(30)]) assert.equal(isDailyQuotaAssistantMessage(text), false);
});
test('quota prefix probing releases ordinary answers and holds fragmented notices', () => {
  for (const prefix of ['Y', "You've reached", 'Você atingiu seu limite diário', 'Your daily conversation']) assert.equal(couldBeDailyQuotaAssistantMessagePrefix(prefix), true);
  for (const prefix of [ordinary, 'You are looking at a normal answer', `"${english}"`]) assert.equal(couldBeDailyQuotaAssistantMessagePrefix(prefix), false);
});
test('all accepted English start forms remain buffered until quota recovery', async () => {
  for (const text of ["You used up today's chat quota. Try again tomorrow.", "You exhausted today's chat limit. Come back tomorrow."]) {
    assert.equal(isDailyQuotaAssistantMessage(text), true);
    assert.equal(couldBeDailyQuotaAssistantMessagePrefix(text), true);
    const result = await streamResult(text);
    assert.equal(result.content, '');
    assert.equal(result.chunks.find(chunk => chunk.error)?.error.code, 'RateLimited');
  }
});
test('non-streaming quota becomes 429 and invalidates completed pinned history', async () => {
  const id = 'quota-json';
  register(id, accounts[0].id);
  setSession('quota-history', { chatId: `${id}-chat`, accountId: accounts[0].id, headers: {}, parentId: 'old-parent', historyComplete: true, updatedAt: Date.now() });
  const result: any = await collectNonStreamingResult({} as any, upstream(english), id, 'qwen3.8-max', `${id}-chat`, false, []);
  assert.equal(result.status, 429);
  assert.equal(result.body.error.code, 'RateLimited');
  assert.equal(result.quotaAccountId, accounts[0].id);
  assert.equal(getSession('quota-history')?.historyComplete, false);
  assert.equal(getStream(id), undefined);
});
test('streaming quota fragments are hidden and rotation emits DONE once', async () => {
  const seen: string[] = [];
  const result = await streamResult(["You've reached ", "today's chat limit. ", 'Try again tomorrow.'], {
    onDailyQuota: async (accountId: string) => { seen.push(accountId); register('quota-helper', accounts[1].id); return { stream: upstream(ordinary, 'replacement', 128), uiSessionId: 'replacement-chat' }; },
  });
  assert.deepEqual(seen, [accounts[0].id]);
  assert.equal(result.content, ordinary);
  assert.equal(result.done, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.registryRemoved, true);
});
for (const mode of ['throw', 'null', 'missing'] as const) {
  test(`quota retry ${mode} terminates with an error and DONE`, async () => {
    const hook = mode === 'missing' ? {} : { onDailyQuota: async () => { if (mode === 'throw') throw new Error('Fixture retry failed'); return null; } };
    const result = await streamResult(english, hook);
    assert.equal(result.content, '');
    assert.equal(result.chunks.find(chunk => chunk.error)?.error.code, 'RateLimited');
    assert.equal(result.done, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.registryRemoved, true);
  });
}
test('a failed replacement stream emits an upstream error and DONE', async () => {
  const result = await streamResult(english, { onDailyQuota: async () => {
    register('quota-helper', accounts[1].id);
    return { uiSessionId: 'broken-replacement', stream: new ReadableStream({ start(controller) { controller.error(new Error('Fixture upstream read failed')); } }) };
  } });
  assert.equal(result.chunks.find(chunk => chunk.error)?.error.code, 'UpstreamReadFailed');
  assert.equal(result.done, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.registryRemoved, true);
});
test('daily quota takes priority over generic Portuguese overload phrases', async () => {
  let overloads = 0;
  let quotas = 0;
  const result = await streamResult(portuguese, {
    onOverloadRetry: async () => { overloads++; return null; },
    onDailyQuota: async () => { quotas++; register('quota-helper', accounts[1].id); return { stream: upstream(ordinary, 'replacement'), uiSessionId: 'replacement-chat' }; },
  });
  assert.equal(overloads, 0);
  assert.equal(quotas, 1);
  assert.equal(result.content, ordinary);
});
test('quota returned by an overload recovery uses the actual replacement account', async () => {
  const seen: string[] = [];
  const result = await streamResult('We are experiencing high demand right now.', {
    onOverloadRetry: async () => { register('quota-helper', accounts[1].id); return { stream: upstream(english, 'quota-replacement'), uiSessionId: 'quota-replacement-chat' }; },
    onDailyQuota: async (id: string) => { seen.push(id); register('quota-helper', accounts[2].id); return { stream: upstream(ordinary, 'final-replacement'), uiSessionId: 'final-chat' }; },
  });
  assert.deepEqual(seen, [accounts[1].id]);
  assert.equal(result.content, ordinary);
  assert.equal(result.done, 1);
});
test('repeated quota from the same account does not create an infinite recovery loop', async () => {
  let calls = 0;
  const result = await streamResult(english, { onDailyQuota: async () => { calls++; return { stream: upstream(english, 'still-quota'), uiSessionId: 'still-quota-chat' }; } });
  assert.equal(calls, 1);
  assert.equal(result.chunks.find(chunk => chunk.error)?.error.code, 'RateLimited');
  assert.equal(result.done, 1);
});

test('ordinary content is delivered while the upstream stream is still open', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const server = new Hono();
  register('quota-live', accounts[0].id);
  server.get('/', c => handleStreamingResponse(c, { stream: source, completionId: 'quota-live', model: 'qwen3.8-max', uiSessionId: 'quota-live-chat', hasTools: false, tools: [], finalPrompt: 'Fixture prompt' }));
  const response = await server.request('/');
  const reader = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response_id: 'live', choices: [{ delta: { phase: 'answer', content: ordinary } }] })}\n\n`));
    const visible = (async () => {
      let text = '';
      while (!parsed(text).content.includes(ordinary)) {
        const next = await reader.read();
        assert.equal(next.done, false);
        text += new TextDecoder().decode(next.value);
      }
      return text;
    })();
    await Promise.race([visible, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Ordinary output was held until upstream close')), 1000); })]);
  } finally {
    clearTimeout(timer);
    controller.close();
    while (!(await reader.read()).done) continue;
    removeStream('quota-live');
  }
});

test('quota during streaming continuation preserves prior output and forbids replay', async () => {
  const previous = config.autoContinue.enabled;
  config.autoContinue.enabled = true;
  const partial = ['The following code continues:\n', '```ts\nconst answer = 42;'];
  const seen: [string, boolean | undefined][] = [];
  setSession('quota-continuation-history', { chatId: 'quota-helper-chat', accountId: accounts[0].id, headers: {}, parentId: null, historyComplete: true, updatedAt: Date.now() });
  try {
    const result = await streamResult(partial, {
      onOverloadRetry: async () => null,
      onAutoContinue: async () => ({ stream: upstream(english, 'continuation'), uiSessionId: 'quota-helper-chat' }),
      onDailyQuota: async (id: string, allowed?: boolean) => { seen.push([id, allowed]); return null; },
    });
    assert.deepEqual(seen, [[accounts[0].id, false]]);
    assert.equal(result.content, partial.join(''));
    assert.equal(result.chunks.find(chunk => chunk.error)?.error.code, 'RateLimited');
    assert.equal(result.done, 1);
    assert.equal(getSession('quota-continuation-history')?.historyComplete, false);
  } finally { config.autoContinue.enabled = previous; }
});

test('quota in a different response is ignored without rotating the selected account', async () => {
  const chunks = [
    { 'response.created': { response_id: 'selected' } },
    { response_id: 'other', choices: [{ delta: { phase: 'answer', content: english } }], usage: { input_tokens: 999, prompt_tokens_details: { cached_tokens: 999 } } },
    { response_id: 'selected', choices: [{ delta: { phase: 'answer', content: ordinary } }], usage: { input_tokens: 200, prompt_tokens_details: { cached_tokens: 128 } } },
  ];
  let calls = 0;
  const source = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)); controller.close(); } });
  const result = await streamResult('', { stream: source, onDailyQuota: async () => { calls++; return null; } });
  assert.equal(calls, 0);
  assert.equal(result.content, ordinary);
  assert.equal(result.done, 1);
});

test('JSON continuation quota rotates the actual account and replaces the incomplete answer', async () => {
  const originalFetch = globalThis.fetch;
  const previous = config.autoContinue.enabled;
  config.autoContinue.enabled = true;
  const routed: string[] = [];
  const partial = 'The following code continues:\n```ts\nconst answer = 42;';
  globalThis.fetch = async () => {
    routed.push(getSession('quota-continue-route')?.accountId || 'missing');
    return new Response(upstream(routed.length === 1 ? partial : routed.length === 2 ? english : ordinary, `continue-${routed.length}`), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8-max', user: 'quota-continue-route', messages: [{ role: 'user', content: 'Explain the fixture.' }], stream: false }) }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.content, ordinary);
    assert.equal(routed.length, 3);
    assert.equal(routed[0], routed[1]);
    assert.notEqual(routed[1], routed[2]);
    assert.equal(getAccountCooldownInfo(routed[1])?.reason, 'RateLimited');
    assert.equal(getAccountCooldownInfo(routed[2]), null);
    assert.equal(getSession('quota-continue-route')?.historyComplete, true);
    for (const account of accounts) assert.equal(getAccountActiveLoad(account.id), 0);
  } finally {
    globalThis.fetch = originalFetch;
    config.autoContinue.enabled = previous;
  }
});

for (const streaming of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} continues on the final account after quota and overload rotation`, async () => {
    const originalFetch = globalThis.fetch;
    const previous = config.autoContinue.enabled;
    config.autoContinue.enabled = true;
    const routed: string[] = [];
    const partial = 'The result of the calculation is (';
    const ending = '42). This is the complete answer.';
    globalThis.fetch = async () => {
      routed.push(accounts.find(account => getAccountActiveLoad(account.id) > 0)?.id || 'missing');
      const content = [english, 'We are experiencing high demand right now.', partial, ending][routed.length - 1];
      return new Response(upstream(content, `combined-${routed.length}`), { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8-max', user: 'quota-combined-route', messages: [{ role: 'user', content: 'Explain the fixture.' }], stream: streaming }) }));
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.equal(streaming ? parsed(text).content : JSON.parse(text).choices[0].message.content, partial + ending);
      assert.equal(routed.length, 4);
      assert.equal(new Set(routed.slice(0, 3)).size, 3);
      assert.equal(routed[3], routed[2]);
      assert.equal(getAccountCooldownInfo(routed[0])?.reason, 'RateLimited');
      assert.equal(getSession('quota-combined-route')?.accountId, routed[2]);
      assert.equal(getSession('quota-combined-route')?.historyComplete, true);
      if (streaming) assert.equal(parsed(text).done, 1);
      for (const account of accounts) assert.equal(getAccountActiveLoad(account.id), 0);
    } finally {
      globalThis.fetch = originalFetch;
      config.autoContinue.enabled = previous;
    }
  });
}

for (const streaming of [false, true]) {
  for (const scenario of ['rotate', 'all-quota', 'retry-fails', 'quoted-notice'] as const) {
    test(`${streaming ? 'SSE' : 'JSON'} route handles ${scenario} without leaking quota text or account slots`, async () => {
      const originalFetch = globalThis.fetch;
      const routed: string[] = [];
      const quote = `"You have reached your daily chat limit. Please try again tomorrow." is an example.`;
      globalThis.fetch = async () => {
        const accountId = getInUseAccounts()[0] || 'guest';
        routed.push(accountId);
        if (scenario === 'retry-fails' && routed.length > 1) throw new Error('Fixture alternative unavailable');
        const content = scenario === 'quoted-notice' ? quote : scenario === 'rotate' && routed.length > 1 ? ordinary : portuguese;
        return new Response(upstream(content, `route-response-${routed.length}`, content === ordinary ? 128 : 0), { headers: { 'content-type': 'text/event-stream' } });
      };
      try {
        const response = await app.fetch(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.8-max', user: 'quota-route-session', messages: [{ role: 'user', content: 'Explain the fixture.' }], stream: streaming, stream_options: { include_usage: true } }) }));
        const text = await response.text();
        const data = streaming ? parsed(text) : { chunks: [JSON.parse(text)], content: JSON.parse(text).choices?.[0]?.message?.content || '', done: 0 };
        if (scenario === 'rotate' || scenario === 'quoted-notice') {
          assert.equal(response.status, 200);
          assert.equal(data.content, scenario === 'rotate' ? ordinary : quote);
          assert.equal(routed.length, scenario === 'rotate' ? 2 : 1);
          if (scenario === 'rotate') {
            assert.notEqual(routed[0], routed[1]);
            assert.equal(getAccountCooldownInfo(routed[0])?.reason, 'RateLimited');
            assert.equal(getAccountCooldownInfo(routed[1]), null);
          } else for (const account of accounts) assert.equal(getAccountCooldownInfo(account.id), null);
          assert.equal(getSession('quota-route-session')?.historyComplete, true);
        } else {
          assert.equal(response.status, streaming ? 200 : 429);
          assert.equal(data.chunks.find(chunk => chunk.error)?.error.code, 'RateLimited');
          assert.equal(data.content, '');
          assert.equal(routed.length, 3, 'try each configured account at most once and do not fall through to guest');
          assert.equal(getSession('quota-route-session')?.historyComplete, false);
          if (scenario === 'all-quota') for (const account of accounts) assert.equal(getAccountCooldownInfo(account.id)?.reason, 'RateLimited');
        }
        if (streaming) assert.equal(data.done, 1);
        for (const account of accounts) assert.equal(getAccountActiveLoad(account.id), 0);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}
