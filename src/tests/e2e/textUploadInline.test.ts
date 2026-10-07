import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.LARGE_PROMPT_THRESHOLD = '1000';
process.env.LARGE_PROMPT_INLINE = 'true';

delete process.env.API_KEY;

const { app } = await import('../../api/server.js');

function setupFetchMock(handler: (url: string, init?: RequestInit, callIndex?: number) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.qwen.ai')) {
      if (urlStr.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      return handler(urlStr, init, callIndex++);
    }
    return originalFetch(input);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('text-upload inline mode: large text prompt is inlined (LARGE_PROMPT_INLINE=true)', async () => {
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, _init) => {
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse(_init?.body as string || '{}'));
      return new Response(
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Conteúdo completo.","phase":"answer"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          }
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'text-upload-inline-chat';

    const bigText = 'x'.repeat(140000);
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: bigText }]
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    assert.strictEqual(capturedPayloads.length, 1);
    const payload = capturedPayloads[0];
    assert.ok(payload.messages[0].content.includes(bigText), 'full text must be inlined when LARGE_PROMPT_INLINE=true');
    assert.ok(payload.messages[0].content.includes('[SYSTEM DIRECTIVE]'), 'answer directive must still be appended');
    assert.strictEqual(payload.messages[0].files.length, 0, 'no file should be attached in inline mode');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});
