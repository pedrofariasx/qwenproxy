import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

delete process.env.API_KEY;

import { app } from '../../api/server.js';

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
    return originalFetch(input);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function mockQwenStreamResponse() {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    }
  });
  return new Response(stream, { status: 200 });
}

test('reasoning_effort: invalid value returns 400', async () => {
  const restore = setupFetchMock(() => mockQwenStreamResponse());
  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'banana'
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.message.includes('banana'));
  } finally {
    restore();
  }
});

test('reasoning_effort: none disables thinking', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((_url, init) => {
    capturedBody = init?.body as string || '';
    return mockQwenStreamResponse();
  });
  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'none'
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody.includes('"thinking_enabled":false'), 'thinking must be disabled');
  } finally {
    restore();
  }
});

test('reasoning_effort: high enables thinking', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((_url, init) => {
    capturedBody = init?.body as string || '';
    return mockQwenStreamResponse();
  });
  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'high'
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody.includes('"thinking_enabled":true'), 'thinking must be enabled');
  } finally {
    restore();
  }
});

test('reasoning_effort: overrides model suffix', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((_url, init) => {
    capturedBody = init?.body as string || '';
    return mockQwenStreamResponse();
  });
  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus-no-thinking',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'high'
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(capturedBody.includes('"thinking_enabled":true'), 'reasoning_effort must override suffix');
  } finally {
    restore();
  }
});
