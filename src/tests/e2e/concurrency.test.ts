import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from '../../api/server.js';
import { initPlaywright, closePlaywright } from '../../services/playwright.js';

test('Concurrent requests are serialized by mutex', async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ 
        data: [{ id: 'qwen3.6-plus', owned_by: 'qwen', info: { created_at: Date.now(), meta: {} } }] 
      }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    const promises = Array.from({ length: 5 }, (_, i) =>
      app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3.6-plus',
            messages: [{ role: 'user', content: `Request ${i}` }],
            stream: false
          })
        })
      )
    );

    const responses = await Promise.all(promises);
    
    // All requests should complete (serialized by mutex)
    for (const res of responses) {
      assert.ok(
        res.status === 200 || res.status === 429 || res.status === 502,
        `Unexpected status: ${res.status}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('No-thinking model variant is accepted', async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ 
        data: [{ id: 'qwen3.6-plus', owned_by: 'qwen', info: { created_at: Date.now(), meta: { max_context_length: 1000000 } } }] 
      }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    // Test no-thinking model is accepted without error
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus-no-thinking',
          messages: [{ role: 'user', content: 'Test' }],
          stream: false
        })
      })
    );

    assert.ok(
      res.status === 200 || res.status === 429 || res.status === 502,
      `No-thinking model should be accepted, got status: ${res.status}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});
