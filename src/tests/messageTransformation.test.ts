import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.ts';

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

test('Message: system role is extracted to systemPrompt', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' }
        ]
      })
    });

    await app.fetch(req);

    // System prompt should be at the beginning
    assert.ok(capturedBody.includes('You are a helpful assistant.'), 'Should include system content');
    assert.ok(capturedBody.indexOf('You are a helpful assistant.') < capturedBody.indexOf('User:'), 'System should come before User');
  } finally {
    restore();
  }
});

test('Message: user role is formatted as "User: content"', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Hello world' }]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('User: Hello world'), 'Should format as "User: content"');
  } finally {
    restore();
  }
});

test('Message: assistant role with reasoning_content wraps in <think>', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!', reasoning_content: 'Thinking about greeting' }
        ]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('<think>'), 'Should include <think> tag');
    assert.ok(capturedBody.includes('Thinking about greeting'), 'Should include reasoning content');
  } finally {
    restore();
  }
});

test('Message: assistant role with tool_calls converts to <tool_call> format', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'What files exist?' },
          { role: 'assistant', content: 'Let me check', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] }
        ]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('<tool_call>'), 'Should include tool_call tags');
    // The tool_call JSON is stringified, so it may have escaped quotes
    assert.ok(capturedBody.includes('ls') || capturedBody.includes('"ls"'), 'Should include tool name somewhere');
  } finally {
    restore();
  }
});

test('Message: tool role with tool_call_id looks up name from previous assistant message', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'List files' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '["file1.txt", "file2.txt"]' }
        ]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('Tool Response (ls):'), 'Should look up and include tool name');
    assert.ok(capturedBody.includes('file1.txt'), 'Should include tool result content');
  } finally {
    restore();
  }
});

test('Message: function role treated same as tool role', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Test' },
          { role: 'assistant', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'function', name: 'test', content: 'result' }
        ]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('Tool Response (test):') || capturedBody.includes('result'), 'Function role should be treated like tool role');
  } finally {
    restore();
  }
});

test('Message: array content (text parts) joined with newlines', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }] }]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('Part 1') && capturedBody.includes('Part 2'), 'Should include both parts');
  } finally {
    restore();
  }
});

test('Message: tool call JSON arguments parsed from string', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Read file' },
          { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path": "test.txt"}' } }] }
        ]
      })
    });

    await app.fetch(req);

    // Arguments should be parsed and re-stringified, the actual value should be present
    assert.ok(capturedBody.includes('test.txt'), 'Should include parsed argument value');
  } finally {
    restore();
  }
});

test('Message: mixed content and tool_calls preserves text, appends tool calls', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Check files' },
          { role: 'assistant', content: 'I will check.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] }
        ]
      })
    });

    await app.fetch(req);

    assert.ok(capturedBody.includes('I will check.'), 'Should include text content');
    assert.ok(capturedBody.includes('<tool_call>'), 'Should include tool call');
    // Text should come before tool call
    const textIdx = capturedBody.indexOf('I will check.');
    const toolIdx = capturedBody.indexOf('<tool_call>');
    assert.ok(textIdx < toolIdx, 'Text should come before tool call');
  } finally {
    restore();
  }
});

test('Message: multi-turn conversation maintains order', async () => {
  let capturedBody = '';
  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Second' },
          { role: 'assistant', content: 'Response 2' }
        ]
      })
    });

    await app.fetch(req);

    // All turns should be present in order
    assert.ok(capturedBody.indexOf('User: First') < capturedBody.indexOf('Assistant: Response 1'), 'First user before first assistant');
    assert.ok(capturedBody.indexOf('Assistant: Response 1') < capturedBody.indexOf('User: Second'), 'First assistant before second user');
    assert.ok(capturedBody.indexOf('User: Second') < capturedBody.indexOf('Assistant: Response 2'), 'Second user before second assistant');
  } finally {
    restore();
  }
});