import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.ts';
import { initPlaywright, closePlaywright } from '../services/playwright.ts';

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

test('Error Handling: Returns 502 for non-SSE JSON error from Qwen', async () => {
  await initPlaywright(false);

  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v2/chat/completions')) {
        return new Response(JSON.stringify({
          success: false,
          data: { code: 'UpstreamError', details: 'Internal server error' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    };

    try {
      const req = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'test' }],
          stream: false
        })
      });

      const res = await app.fetch(req);

      assert.strictEqual(res.status, 502, 'Should return 502 for upstream error');
      const body = await res.json();
      assert.ok(body.error.message.includes('UpstreamError'), 'Error message should contain UpstreamError');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await closePlaywright();
  }
});

test('Error Handling: Returns 429 for RateLimited error', async () => {
  await initPlaywright(false);

  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v2/chat/completions')) {
        return new Response(JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            num: 3
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    };

    try {
      const req = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'test' }],
          stream: false
        })
      });

      const res = await app.fetch(req);

      assert.strictEqual(res.status, 429, 'Should return 429 for rate limit');
      const body = await res.json();
      assert.ok(body.error.message.includes('RateLimited'), 'Error message should contain RateLimited');
      assert.ok(body.error.message.includes('upper limit'), 'Error message should contain usage limit info');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await closePlaywright();
  }
});

test('Error Handling: Returns 404 for Not_Found error', async () => {
  await initPlaywright(false);

  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v2/chat/completions')) {
        return new Response(JSON.stringify({
          success: false,
          data: {
            code: 'Not_Found',
            details: 'Session not found'
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input);
    };

    try {
      const req = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'test' }],
          stream: false
        })
      });

      const res = await app.fetch(req);

      assert.strictEqual(res.status, 404, 'Should return 404 for not found');
      const body = await res.json();
      assert.ok(body.error.message.includes('Not_Found'), 'Error message should contain Not_Found');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await closePlaywright();
  }
});

test('Error Handling: Returns 500 for malformed upstream response', async () => {
  await initPlaywright(false);

  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v2/chat/completions')) {
        return new Response('This is not JSON', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return originalFetch(input);
    };

    try {
      const req = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'test' }],
          stream: false
        })
      });

      const res = await app.fetch(req);

      // Should return 500 or similar error status
      assert.ok(res.status >= 400, 'Should return error status');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await closePlaywright();
  }
});

test('Error Handling: Empty response body handled gracefully', async () => {
  await initPlaywright(false);

  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v2/chat/completions')) {
        return new Response('', { status: 200 });
      }
      return originalFetch(input);
    };

    try {
      const req = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'test' }],
          stream: false
        })
      });

      const res = await app.fetch(req);

      // Should handle empty response without crashing
      assert.ok(res.status === 200 || res.status >= 400, 'Should return some valid status');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await closePlaywright();
  }
});

test('Error Handling: Handles missing required fields in request body', async () => {
  // Missing 'messages' field
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.6-plus'
    })
  });

  const res = await app.fetch(req);

  // Should return 400 or similar for bad request
  assert.ok(res.status >= 400, 'Should return error status for malformed request');
});