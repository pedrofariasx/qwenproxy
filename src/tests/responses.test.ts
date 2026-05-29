import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../api/server.js';
import { closePlaywright, initPlaywright } from '../services/playwright.ts';

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

function parseSseEvents(text: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.trim().split(/\n\n+/)) {
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) continue;
    const event = eventLine.slice(7).trim();
    const dataStr = dataLine.slice(6).trim();
    if (dataStr === '[DONE]') continue;
    events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
}

async function readResponseText(res: Response, timeoutMs = 5000): Promise<string> {
  const reader = res.body?.getReader();
  assert.ok(reader, 'Response should have a readable body');
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let combined = '';

  while (true) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('timeout reading response body')), timeoutMs);
      timeoutHandle?.unref?.();
    });

    const result = await Promise.race([reader.read(), timeout]) as ReadableStreamReadResult<Uint8Array>;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (result.done) break;
    const part = decoder.decode(result.value, { stream: true });
    chunks.push(part);
    combined += part;
    if (combined.includes('data: [DONE]')) {
      break;
    }
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

async function readSseUntil(res: Response, needle: string, timeoutMs = 5000): Promise<string> {
  const reader = res.body?.getReader();
  assert.ok(reader, 'Response should have a readable body');
  const decoder = new TextDecoder();
  let combined = '';
  const timeoutHandle = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = decoder.decode(result.value, { stream: true });
      combined += chunk;
      if (combined.includes(needle)) break;
    }
    return combined + decoder.decode();
  } finally {
    clearTimeout(timeoutHandle);
    await reader.cancel().catch(() => {});
  }
}

test('responses endpoint returns OpenAI-style response object', async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Hello from Qwen"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'Say hi',
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'response');
    assert.strictEqual(body.status, 'completed');
    assert.strictEqual(body.output_text, 'Hello from Qwen');
    assert.ok(Array.isArray(body.output));
    assert.strictEqual(body.output[0].type, 'message');
  } finally {
    restore();
    await closePlaywright();
  }
});

test('responses endpoint streams SSE events and keeps tool calls', async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"echo\\",\\"arguments\\":{\\"value\\":\\"ok\\"}}</tool_call>"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  });

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'call a tool',
        stream: true,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type')?.startsWith('text/event-stream'), true);

    const text = await readResponseText(res);
    const events = parseSseEvents(text);
    assert.ok(events.some((event) => event.event === 'response.created'));
    assert.ok(events.some((event) => event.event === 'response.output_item.added'));
    assert.ok(events.some((event) => event.event === 'response.completed'));
  } finally {
    restore();
    await closePlaywright();
  }
});
