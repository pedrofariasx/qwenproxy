import test from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app, __setStartupHealthStateForTests } from '../api/server.js';
import { setTestOptions } from '../services/playwright.ts';
import { loadAccounts } from '../core/accounts.ts';
import { resetModelCache } from '../api/models.js';
import { clearAccountCooldown, markAccountRateLimited } from '../core/account-manager.ts';
import { configEnvContract, legacyConfigEnvContract } from '../core/config.ts';

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.qwen.ai')) {
      if (urlStr.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function setStartupState(partial: Partial<Parameters<typeof __setStartupHealthStateForTests>[0]>) {
  __setStartupHealthStateForTests({
    cacheReady: false,
    watchdogReady: false,
    metricsReady: false,
    prewarmComplete: false,
    expectedSessions: 0,
    readySessions: 0,
    failedSessions: 0,
    errors: [],
    ...partial,
  });
}

test('health check reports unknown before bootstrap', async () => {
  setStartupState({});

  const res = await app.fetch(new Request('http://localhost/health'));
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'unknown');
  assert.strictEqual(body.startup.status, 'unknown');
  assert.strictEqual(body.startup.cacheReady, false);
  assert.strictEqual(body.startup.watchdogReady, false);
});

test('health check reports degraded during warmup and ok when ready', async () => {
  setStartupState({
    cacheReady: true,
    watchdogReady: true,
    metricsReady: true,
    prewarmComplete: false,
    expectedSessions: 1,
    readySessions: 0,
    failedSessions: 0,
    errors: [],
  });

  const degraded = await app.fetch(new Request('http://localhost/health'));
  const degradedBody = await degraded.json();
  assert.strictEqual(degradedBody.status, 'degraded');
  assert.strictEqual(degradedBody.startup.status, 'degraded');
  assert.strictEqual(degradedBody.startup.prewarmComplete, false);

  setStartupState({
    cacheReady: true,
    watchdogReady: true,
    metricsReady: true,
    prewarmComplete: true,
    expectedSessions: 1,
    readySessions: 1,
    failedSessions: 0,
    errors: [],
  });

  const healthy = await app.fetch(new Request('http://localhost/health'));
  const healthyBody = await healthy.json();
  assert.strictEqual(healthyBody.status, 'ok');
  assert.strictEqual(healthyBody.startup.status, 'ok');
  assert.strictEqual(healthyBody.startup.readySessions, 1);
});

test('models endpoint returns qwen3.6-plus and qwen3.6-plus-no-thinking', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    return originalFetch(input);
  };

  setTestOptions({ mockMode: true, mockSessionId: 'mock-session' });

  try {
    const req = new Request('http://localhost/v1/models');
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((m: any) => m.id === 'qwen3.6-plus'));
    assert.ok(body.data.some((m: any) => m.id === 'qwen3.6-plus-no-thinking'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('models endpoint returns static fallback when Playwright is not initialized', async () => {
  resetModelCache(); // prevent cross-test cache pollution
  const originalMode = process.env.TEST_MOCK_PLAYWRIGHT;
  const accounts = loadAccounts();
  const blockedAccountIds = accounts.map(account => account.id);
  setTestOptions({ mockMode: false });
  process.env.TEST_MOCK_PLAYWRIGHT = 'false';

  for (const accountId of blockedAccountIds) {
    markAccountRateLimited(accountId, 5 * 60 * 1000, 'test-block');
  }

  try {
    const req = new Request('http://localhost/v1/models');
    const res = await app.fetch(req);

    // Static fallback returns 200 with a list of known Qwen models
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.data), 'should return a models list');
    assert.ok(body.data.length >= 8, 'should include at least 8 static models (base + no-thinking variants)');
    // Verify known model is present
    const modelIds = body.data.map((m: any) => m.id);
    assert.ok(modelIds.includes('qwen3.7-max'), 'should include qwen3.7-max in fallback list');
  } finally {
    for (const accountId of blockedAccountIds) {
      clearAccountCooldown(accountId);
    }
    setTestOptions({ mockMode: true, mockSessionId: 'mock-session' });
    process.env.TEST_MOCK_PLAYWRIGHT = originalMode;
  }
});

test('config contract stays aligned with docs for critical variables', async () => {
  const envExample = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  const criticalSpecs = configEnvContract.filter((spec) => [
    'API_KEY',
    'BROWSER_HEADLESS',
    'BROWSER',
    'QWEN_PROFILES_PATH',
    'CACHE_TTL',
    'WATCHDOG_INTERVAL',
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_HEADER',
    'EXECUTOR_TIMEOUT_MS',
    'TOOL_TIMEOUT_MS',
    'TOOL_MAX_ARGUMENTS_BYTES',
    'TOOL_MAX_RESULT_BYTES',
  ].includes(spec.name));

  for (const spec of criticalSpecs) {
    assert.ok(envExample.includes(`${spec.name}=`), `Missing ${spec.name} from .env.example`);
    assert.ok(readme.includes(spec.name), `Missing ${spec.name} from README.md`);
    assert.ok(envExample.includes(`Default: ${spec.defaultValue}`) || envExample.includes(`# Default: ${spec.defaultValue}`), `Missing default ${spec.defaultValue} for ${spec.name} in .env.example`);
  }

  assert.ok(readme.includes('/health'));
  assert.ok(readme.includes('/v1/models'));
  assert.ok(readme.includes('API_KEY'));
  assert.ok(readme.includes('unknown'));
  assert.ok(readme.includes('degraded'));
  assert.ok(readme.includes('ok'));

  for (const legacySpec of legacyConfigEnvContract) {
    assert.ok(envExample.includes(legacySpec.name), `Missing legacy variable ${legacySpec.name} from .env.example`);
  }
});

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedBody = '';

  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    assert.ok(capturedBody.includes('hello') || capturedBody.includes('User: hello'), 'Must include user message');
    assert.ok(capturedBody.includes('thinking about hello'), 'Must include reasoning content');
    assert.ok(capturedBody.includes('tool_call') || capturedBody.includes('"name": "test"'), 'Must include tool call info');
    assert.ok(capturedBody.includes('Tool Response (test): success') || capturedBody.includes('success'), 'Must include tool response');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "   ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "  hello  ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "\\n\\n  ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'test' }], stream: true })
    });

    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch (e) {
          }
        }
      }
    }

    assert.strictEqual(full, '     hello  \n\n  ');
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "done", "phase": "answer"}}], "usage": {"output_tokens": 10}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{ role: 'user', content: 'test' }], stream: true })
    });

    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch (e) {
          }
        }
      }
    }

    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0);
  } finally {
    restore();
  }
});

test('session-parent-tracking: appends messages using response message_id as parent', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);

    const mockMessageId = capturedPayloads.length === 1 ? 'qwen-1001' : 'qwen-1002';

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"response.created":{"response_id":"${mockMessageId}"}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });

    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });

    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-1001', 'Turn 2 should use response_id from Turn 1 as parent');
    assert.strictEqual(capturedPayloads[1].messages[0].content, 'User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n', 'Should send the full OpenAI message history');
  } finally {
    restore();
  }
});
