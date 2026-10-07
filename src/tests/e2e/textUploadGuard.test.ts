import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.LARGE_PROMPT_THRESHOLD = '1000';

delete process.env.API_KEY;

const { app } = await import('../../api/server.js');
const { isDegenerateAnswer, buildAnswerDirective } = await import('../../utils/degenerate-answer.js');

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

const STS_BODY = JSON.stringify({
  success: true,
  request_id: 'r',
  data: {
    access_key_id: 'ak',
    access_key_secret: 'sk',
    security_token: 'st',
    file_url: 'http://mock-oss/prompt.txt',
    file_path: 'p/prompt.txt',
    file_id: 'file-id-1',
    bucketname: 'b',
    region: 'cn-hongkong',
    endpoint: 'oss.example.com',
  },
});

function sseAnswer(content: string): Response {
  const enc = new TextEncoder();
  let done = false;
  return new Response(new ReadableStream({
    pull(c) {
      if (done) { c.close(); return; }
      done = true;
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(content)},"phase":"answer"}}],"usage":{"output_tokens":${content.length}}}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
    }
  }), { status: 200 });
}

test('degenerate-answer: detects terse acknowledgments', () => {
  assert.strictEqual(isDegenerateAnswer('Yes'), true);
  assert.strictEqual(isDegenerateAnswer('Yes.'), true);
  assert.strictEqual(isDegenerateAnswer('Sim'), true);
  assert.strictEqual(isDegenerateAnswer('Claro que sim'), true);
  assert.strictEqual(isDegenerateAnswer('OK'), true);
  assert.strictEqual(isDegenerateAnswer('Entendido.'), true);
  assert.strictEqual(isDegenerateAnswer(''), false);
  assert.strictEqual(isDegenerateAnswer('A resposta completa com todos os detalhes que você pediu.'), false);
  assert.strictEqual(isDegenerateAnswer('Yes, and here is the full reasoning that follows.'), false);
  assert.strictEqual(isDegenerateAnswer('Sim, vamos fazer X, Y e Z.'), false);
});

test('degenerate-answer: builds corrective directive referencing the rejected reply', () => {
  const directive = buildAnswerDirective('Yes');
  assert.ok(directive.includes('Your previous reply (Yes) was rejected'));
  assert.ok(directive.includes('NEVER reply with only a short acknowledgment'));
  const plain = buildAnswerDirective();
  assert.ok(!plain.includes('Your previous reply'));
});

test('text-upload guard: large text prompt is attached as file, not inlined', async () => {
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, _init) => {
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(STS_BODY, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse(_init?.body as string || '{}'));
      return sseAnswer('Conteúdo completo.');
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'text-upload-chat';

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
    const body = await res.json() as any;
    assert.strictEqual(body.choices[0].message.content, 'Conteúdo completo.');

    assert.strictEqual(capturedPayloads.length, 1);
    const payload = capturedPayloads[0];
    assert.ok(!payload.messages[0].content.includes(bigText), 'full text must NOT be inlined (would trip captcha)');
    assert.ok(payload.messages[0].content.includes('[SYSTEM DIRECTIVE]'), 'read-directive must be appended');
    assert.ok(payload.messages[0].content.includes('NEVER reply with only a short acknowledgment'));
    assert.strictEqual(payload.messages[0].files.length, 1, 'large prompt must be attached as a file');
    assert.ok(payload.messages[0].files[0].name.startsWith('prompt_'), 'attached file should be the uploaded prompt');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('degenerate guard: non-streaming "Yes" is retried once with corrective directive', async () => {
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((_url, _init, callIndex) => {
    if (_url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse((_init as any)?.body as string || '{}'));
      return sseAnswer(callIndex === 0 ? 'Yes' : 'A resposta completa, explicando tudo em detalhes.');
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'degenerate-guard-chat';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Explique o que é um proxy e como funciona.' }]
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.choices[0].message.content, 'A resposta completa, explicando tudo em detalhes.');

    assert.strictEqual(capturedPayloads.length, 2, 'degenerate reply must trigger exactly one retry');
    assert.ok(capturedPayloads[1].messages[0].content.includes('[SYSTEM DIRECTIVE]'));
    assert.ok(capturedPayloads[1].messages[0].content.includes('NEVER reply with only a short acknowledgment'));
    assert.ok(!capturedPayloads[1].messages[0].content.includes('Your previous reply'), 'retry must happen on a clean chat (no pollution)');
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('streaming guard: degenerate "Yes" is regenerated before reaching the client', async () => {
  const capturedPayloads: any[] = [];

  const { setSession } = await import('../../services/session-manager.js');
  setSession('stream-guard-chat', {
    chatId: 'stream-guard-chat',
    accountId: 'stream-guard-account',
    headers: {},
    parentId: 'resp-prev',
    historyComplete: true,
    updatedAt: Date.now(),
  });

  const restore = setupFetchMock((_url, init, callIndex) => {
    if (_url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse((init as any)?.body as string || '{}'));
      return sseAnswer(callIndex === 0 ? 'Yes' : 'Resposta completa com todos os detalhes que você pediu.');
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'stream-guard-chat';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'stream-guard-chat',
        messages: [{ role: 'user', content: 'Explique em detalhes.' }],
        stream: true
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const text = await res.text();

    let fullContent = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') fullContent += delta;
      } catch { /* skip */ }
    }

    assert.ok(!/^\s*Yes\s*$/.test(fullContent), 'the degenerate "Yes" must never reach the client');
    assert.ok(fullContent.includes('Resposta completa'), 'the regenerated answer must be streamed');
    assert.strictEqual(capturedPayloads.length, 2, 'a retry must have been triggered');
    assert.ok(capturedPayloads[1].messages[0].content.includes('[SYSTEM DIRECTIVE]'));
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('streaming guard: multimodal file upload degenerate "Yes" is regenerated', async () => {
  const capturedPayloads: any[] = [];

  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('note.txt')) {
      return new Response('conteudo do arquivo enviado', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (urlStr.includes('chat.qwen.ai')) {
      if (urlStr.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (urlStr.includes('/api/v2/files/getstsToken')) {
        return new Response(STS_BODY, { status: 200 });
      }
      if (urlStr.includes('/api/v2/chat/completions')) {
        capturedPayloads.push(JSON.parse((init as any)?.body as string || '{}'));
        return sseAnswer(callIndex++ === 0 ? 'Yes' : 'Resposta completa sobre o documento enviado.');
      }
    }
    return originalFetch(input);
  };

  try {
    process.env.TEST_SESSION_ID = 'stream-guard-multimodal';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Resuma o conteúdo do arquivo em detalhes.' },
            { type: 'file_url', file_url: { url: 'http://example.com/note.txt' } }
          ]
        }],
        stream: true
      })
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const text = await res.text();

    let fullContent = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') fullContent += delta;
      } catch { /* skip */ }
    }

    assert.ok(fullContent.trim() !== 'Yes', 'the degenerate "Yes" must never reach the client');
    assert.ok(fullContent.includes('Resposta completa'), 'the regenerated answer must be streamed');
    assert.strictEqual(capturedPayloads.length, 2, 'a retry must have been triggered');
    assert.ok(capturedPayloads[1].messages[0].content.includes('[SYSTEM DIRECTIVE]'));
    assert.ok(capturedPayloads[0].messages[0].content.includes('[File: note.txt]'), 'text document must be inlined');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_SESSION_ID;
  }
});

test('processImagesForQwen: text documents are inlined, not attached as files', async () => {
  const originalFetch = globalThis.fetch;
  const stsUrl = 'https://chat.qwen.ai/api/v2/files/getstsToken';
  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr === stsUrl || urlStr.includes('/api/v2/files/getstsToken')) {
      return new Response(STS_BODY, { status: 200 });
    }
    if (urlStr.includes('example.com/note.txt') || urlStr.includes('note.txt')) {
      return new Response('conteudo do arquivo txt', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return originalFetch(input);
  };

  try {
    const { processImagesForQwen } = await import('../../routes/upload.js');
    const result = await processImagesForQwen(
      [{ type: 'file_url', file_url: { url: 'http://example.com/note.txt' } }],
      { cookie: 'c', 'user-agent': 'UA', 'bx-ua': 'x', 'bx-umidtoken': 'y', 'bx-v': '2.5.37' },
    );
    assert.ok(result.docText.includes('[File: note.txt]'), 'must label the inline document');
    assert.ok(result.docText.includes('conteudo do arquivo txt'), 'must inline the text content');
    assert.strictEqual(result.files.length, 0, 'text documents must not be attached as files');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
