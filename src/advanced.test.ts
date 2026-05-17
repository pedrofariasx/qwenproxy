import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

delete process.env.API_KEY;

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.qwen.ai')) {
      // Handle models list request separately if handler doesn't
      if (urlStr.includes('/api/models')) {
         return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    // Qwen uses messages array in payload, not a single prompt string
    capturedPrompt = bodyObj.messages?.[0]?.content || '';
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

    // Validate that only the last message is sent (as requested by user)
    // In this case, the last message is the tool response
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
    assert.ok(!capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Should not include previous thinking');
    assert.ok(!capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Should not include previous tool call');
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
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{role: 'user', content: 'test'}], stream: true })
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
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
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
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{role: 'user', content: 'test'}], stream: true })
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
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

test('tool-calls: non-streaming converts Bengali delimiters to OpenAI tool_calls', async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"তত\\n{\\"name\\":\\"session_search\\",\\"arguments\\":{\\"query\\":\\"usagi OR brettchalupa\\"}}✨","phase":"answer"}}]}\n\n'));
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
        stream: false,
        messages: [{ role: 'user', content: 'search history' }],
        tools: [{ type: 'function', function: { name: 'session_search', parameters: { type: 'object' } } }]
      })
    });

    const res = await app.fetch(req);
    const body = await res.json() as any;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.choices[0].message.content, null);
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(body.choices[0].message.tool_calls[0].function.name, 'session_search');
    assert.deepStrictEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { query: 'usagi OR brettchalupa' });
  } finally {
    restore();
  }
});

test('tool-calls: streaming converts Bengali delimiters without leaking marker text', async () => {
  const restore = setupFetchMock(() => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ত","phase":"answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ত\\n{\\"name\\":\\"session_search\\",\\"arguments\\":{\\"query\\":\\"usagi\\"}}✨","phase":"answer"}}]}\n\n'));
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
        stream: true,
        messages: [{ role: 'user', content: 'search history' }],
        tools: [{ type: 'function', function: { name: 'session_search', parameters: { type: 'object' } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(!text.includes('তত'));
    assert.ok(!text.includes('✨'));
    assert.ok(text.includes('"tool_calls"'));
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    restore();
  }
});

test('session-parent-tracking: appends messages using response message_id as parent', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    // Simulate Qwen returning a response_id
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
    // Turn 1
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
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
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
    // In Turn 1, parent_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_id, null);
    // In Turn 2, parent_id should be qwen-1001 (the ID returned in Turn 1)
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-1001', 'Turn 2 should use response_id from Turn 1 as parent');
    assert.strictEqual(capturedPayloads[1].messages[0].content, 'User: Turn 2\n\n', 'Should only send the last message');
  } finally {
    restore();
  }
});
