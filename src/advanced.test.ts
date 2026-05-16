import test from 'node:test';
import assert from 'node:assert';
import { resetHybridConversationState } from './services/qwen.ts';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

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

test('multiturn-thinking-tools: preserves conversation history in fresh chat mode', async () => {
  resetHybridConversationState();
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

    assert.ok(capturedPrompt.includes('User: hello'), 'Must include previous user message');
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
    assert.ok(capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Should include previous thinking');
    assert.ok(capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Should include previous tool call');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  resetHybridConversationState();
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
  resetHybridConversationState();
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

test('headerless-requests: rebuild full history instead of reusing Qwen chat state', async () => {
  resetHybridConversationState();
  let capturedPayloads: unknown[] = [];
  let capturedUrls: string[] = [];

  const restore = setupFetchMock((url, init) => {
    capturedUrls.push(url);
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-1"}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Response 1"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'fresh-chat-session';

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
    // Consume the stream to complete the request lifecycle
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
    assert.strictEqual(capturedUrls.length, 2);
    const firstPayload = capturedPayloads[0] as { parent_id: string | null; chat_id: string | null; messages: Array<{ content: string }> };
    const secondPayload = capturedPayloads[1] as { parent_id: string | null; chat_id: string | null; messages: Array<{ content: string }> };

    assert.strictEqual(firstPayload.parent_id, null);
    assert.strictEqual(firstPayload.chat_id, 'fresh-chat-session');
    assert.strictEqual(secondPayload.parent_id, null);
    assert.strictEqual(secondPayload.chat_id, 'fresh-chat-session');
    assert.ok(capturedUrls[0].includes('chat_id=fresh-chat-session'));
    assert.ok(capturedUrls[1].includes('chat_id=fresh-chat-session'));
    assert.strictEqual(
      secondPayload.messages[0].content,
      'User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n',
      'Should rebuild the full conversation when no explicit chat key exists'
    );
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('explicit-chat-key: reuses the same Qwen chat and sends only the delta', async () => {
  resetHybridConversationState();
  let capturedPayloads: unknown[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);

    const stream = new ReadableStream({
      start(controller) {
        const responseId = capturedPayloads.length === 1 ? 'qwen-parent-1' : 'qwen-parent-2';
        controller.enqueue(new TextEncoder().encode(`data: {"response.created":{"response_id":"${responseId}"}}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Response"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'explicit-chat-session';

    const baseHeaders = {
      'Content-Type': 'application/json',
      'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
    };

    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: baseHeaders,
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
      headers: baseHeaders,
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });

    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    const firstPayload = capturedPayloads[0] as { parent_id: string | null; messages: Array<{ content: string }> };
    const secondPayload = capturedPayloads[1] as { parent_id: string | null; messages: Array<{ content: string }> };

    assert.strictEqual(firstPayload.parent_id, null);
    assert.strictEqual(firstPayload.messages[0].content, 'User: Turn 1\n\n');
    assert.strictEqual(secondPayload.parent_id, 'qwen-parent-1');
    assert.strictEqual(secondPayload.messages[0].content, 'User: Turn 2\n\n');
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('json-error-response: returns a clear server error when Qwen does not stream', async () => {
  resetHybridConversationState();
  const restore = setupFetchMock(() => {
    return new Response(
      JSON.stringify({
        success: false,
        data: {
          code: 'RequestValidationError',
          details: 'chat_id is required'
        }
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    );
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Oi' }]
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 500);

    const body = await res.json();
    assert.match(body.error.message, /Qwen returned JSON instead of stream/);
  } finally {
    restore();
  }
});

test('hybrid-retry: retries when Qwen rate limits a reused chat before emitting content', async () => {
  resetHybridConversationState();
  let callCount = 0;

  const restore = setupFetchMock(() => {
    callCount += 1;

    if (callCount === 2) {
      const rateLimitedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-1"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"error":{"code":"internal_error","details":"Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."},"response_id":"qwen-parent-1"}\n\n'));
          controller.close();
        }
      });

      return new Response(rateLimitedStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      });
    }

    const successStream = new ReadableStream({
      start(controller) {
        const responseId = callCount === 1 ? 'qwen-parent-1' : 'qwen-parent-2';
        controller.enqueue(new TextEncoder().encode(`data: {"response.created":{"response_id":"${responseId}"}}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"Resposta final"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(successStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  });

  try {
    process.env.TEST_SESSION_ID = 'fresh-chat-session';

    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Primeiro turno' }]
      })
    });

    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: 'Resposta 1' },
          { role: 'user', content: 'Segundo turno' }
        ],
        stream: true
      })
    });

    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);

    const bodyText = await res2.text();
    assert.match(bodyText, /Resposta final/);
    assert.strictEqual(callCount, 3);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('semantic-tool-retry: asks Qwen to resend a valid tool call once', async () => {
  resetHybridConversationState();
  let callCount = 0;
  const capturedPayloads: Array<{ parent_id: string | null; messages: Array<{ content: string }> }> = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}') as { parent_id: string | null; messages: Array<{ content: string }> };
    capturedPayloads.push(bodyObj);
    callCount += 1;

    const stream = new ReadableStream({
      start(controller) {
        if (callCount === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-invalid"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": null, \\"arguments\\": 123}</tool_call>"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-fixed"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": \\"apply_patch\\", \\"arguments\\": {\\"path\\": \\"demo.txt\\"}}</tool_call>"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  });

  try {
    process.env.TEST_SESSION_ID = 'semantic-retry-session';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Use a tool agora' }],
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              description: 'Aplica patch',
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string' }
                },
                required: ['path']
              }
            }
          }
        ]
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const bodyText = await res.text();
    assert.strictEqual(callCount, 2);
    assert.match(bodyText, /"tool_calls"/);
    assert.doesNotMatch(bodyText, /<tool_call>\{\\"name\\": null, \\"arguments\\": 123}<\/tool_call>/);
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-parent-invalid');
    assert.match(capturedPayloads[1].messages[0].content, /Re-send ONLY the corrected tool call block/);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
 });

test('semantic-tool-retry: falls back to raw tool call after retry limit is exhausted', async () => {
  resetHybridConversationState();
  let callCount = 0;

  const restore = setupFetchMock(() => {
    callCount += 1;

    const stream = new ReadableStream({
      start(controller) {
        const responseId = callCount === 1 ? 'qwen-parent-invalid-1' : 'qwen-parent-invalid-2';
        controller.enqueue(new TextEncoder().encode(`data: {"response.created":{"response_id":"${responseId}"}}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": null, \\"arguments\\": 123}</tool_call>"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  });

  try {
    process.env.TEST_SESSION_ID = 'semantic-retry-fallback-session';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Use uma ferramenta' }],
        stream: true,
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const bodyText = await res.text();
    assert.strictEqual(callCount, 2);
    assert.match(bodyText, /<tool_call>\{\\"name\\": null, \\"arguments\\": 123}<\/tool_call>/);
    assert.doesNotMatch(bodyText, /"tool_calls"/);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('semantic-tool-retry: keeps reasoning chunks before asking for corrected tool call', async () => {
  resetHybridConversationState();
  let callCount = 0;
  const capturedPayloads: Array<{ parent_id: string | null; messages: Array<{ content: string }> }> = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}') as { parent_id: string | null; messages: Array<{ content: string }> };
    capturedPayloads.push(bodyObj);
    callCount += 1;

    const stream = new ReadableStream({
      start(controller) {
        if (callCount === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-thinking-invalid"}}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"thinking_summary","extra":{"summary_thought":{"content":["Pensando no plano"]}}}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": null, \\"arguments\\": 123}</tool_call>"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-thinking-fixed"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": \\"apply_patch\\", \\"arguments\\": {\\"path\\": \\"reasoned.txt\\"}}</tool_call>"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  });

  try {
    process.env.TEST_SESSION_ID = 'semantic-retry-reasoning-session';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Pense e use uma ferramenta' }],
        stream: true,
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const bodyText = await res.text();
    assert.strictEqual(callCount, 2);
    assert.match(bodyText, /Pensando no plano/);
    assert.match(bodyText, /"tool_calls"/);
    assert.strictEqual(capturedPayloads[1].parent_id, 'qwen-parent-thinking-invalid');
    assert.match(capturedPayloads[1].messages[0].content, /Re-send ONLY the corrected tool call block/);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('semantic-tool-retry: does not retry when a valid tool call was already emitted', async () => {
  resetHybridConversationState();
  let callCount = 0;

  const restore = setupFetchMock(() => {
    callCount += 1;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-mixed"}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\": \\"apply_patch\\", \\"arguments\\": {\\"path\\": \\"ok.txt\\"}}</tool_call><tool_call>{\\"name\\": null, \\"arguments\\": 123}</tool_call>"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    });
  });

  try {
    process.env.TEST_SESSION_ID = 'semantic-no-retry-after-valid-session';

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-chat-key': 'fixed-session:nexus:qwen-local:qwen3.6-plus'
      },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Use duas ferramentas' }],
        stream: true,
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const bodyText = await res.text();
    assert.strictEqual(callCount, 1);
    assert.match(bodyText, /"tool_calls"/);
    assert.match(bodyText, /<tool_call>\{\\"name\\": null, \\"arguments\\": 123}<\/tool_call>/);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});
