import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Ensure API_KEY is empty by default for existing tests
process.env.API_KEY = '';

import { app } from '../index.ts';
import { initPlaywright, closePlaywright } from '../services/playwright.ts';

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns qwen3.6-plus and qwen3.6-plus-no-thinking', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    return originalFetch(input);
  };

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

test('Modes endpoint returns chat and coder usage modes', async () => {
  const req = new Request('http://localhost/v1/modes');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'chat'));
  assert.ok(body.data.some((m: any) => m.id === 'coder'));
});

test('Create chat endpoint creates a persistent chat record', async () => {
  const req = new Request('http://localhost/v1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'My chat', model: 'qwen3.6-plus', mode: 'coder' })
  });

  const res = await app.fetch(req);
  assert.strictEqual(res.status, 201);

  const body = await res.json();
  assert.strictEqual(body.object, 'chat');
  assert.ok(body.data.id, 'Chat id should be returned');
  assert.strictEqual(body.data.title, 'My chat');
  assert.strictEqual(body.data.model, 'qwen3.6-plus');
  assert.strictEqual(body.data.mode, 'coder');
  assert.deepStrictEqual(body.data.messages, []);
  assert.ok(body.links?.messages, 'Should expose messages link');

  const getRes = await app.fetch(new Request(`http://localhost/v1/chats/${body.data.id}`));
  assert.strictEqual(getRes.status, 200);
  const stored = await getRes.json();
  assert.strictEqual(stored.data.id, body.data.id);
  assert.strictEqual(stored.data.title, 'My chat');
  assert.strictEqual(stored.data.mode, 'coder');

  const modeRes = await app.fetch(new Request(`http://localhost/v1/chats/${body.data.id}/mode`));
  assert.strictEqual(modeRes.status, 200);
  const modeBody = await modeRes.json();
  assert.strictEqual(modeBody.object, 'chat.mode');
  assert.strictEqual(modeBody.data.mode, 'coder');

  const patchRes = await app.fetch(new Request(`http://localhost/v1/chats/${body.data.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'chat', title: 'Updated chat' })
  }));
  assert.strictEqual(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.strictEqual(patched.data.mode, 'chat');
  assert.strictEqual(patched.data.title, 'Updated chat');

  const messagesRes = await app.fetch(new Request(`http://localhost/v1/chats/${body.data.id}/messages`));
  assert.strictEqual(messagesRes.status, 200);
  const messagesBody = await messagesRes.json();
  assert.strictEqual(messagesBody.object, 'chat.messages');
  assert.strictEqual(messagesBody.data.totalMessages, 0);

  const deleteRes = await app.fetch(new Request(`http://localhost/v1/chats/${body.data.id}`, {
    method: 'DELETE'
  }));
  assert.strictEqual(deleteRes.status, 200);
});

test('Create chat endpoint accepts empty body and rejects malformed JSON', async () => {
  const emptyRes = await app.fetch(new Request('http://localhost/v1/chats', {
    method: 'POST'
  }));
  assert.strictEqual(emptyRes.status, 201);
  const emptyBody = await emptyRes.json();
  assert.ok(emptyBody.data.id);

  const malformedRes = await app.fetch(new Request('http://localhost/v1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  }));
  assert.strictEqual(malformedRes.status, 400);

  await app.fetch(new Request(`http://localhost/v1/chats/${emptyBody.data.id}`, {
    method: 'DELETE'
  }));
});

test('Chat completions persists messages under an existing chat id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const createRes = await app.fetch(new Request('http://localhost/v1/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Persist me', model: 'qwen3.6-plus' })
    }));
    const created = await createRes.json();

    const completionRes = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: created.data.id,
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      })
    }));
    assert.strictEqual(completionRes.status, 200);

    const messagesRes = await app.fetch(new Request(`http://localhost/v1/chats/${created.data.id}/messages`));
    assert.strictEqual(messagesRes.status, 200);
    const messagesBody = await messagesRes.json();
    assert.ok(messagesBody.data.messages.some((m: any) => m.role === 'assistant' && m.content === 'Hello'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint returns OpenAI-compatible response object', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello from responses"}}], "usage": {"input_tokens": 4, "output_tokens": 3}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        instructions: 'Be concise.',
        input: 'Say hello'
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.object, 'response');
    assert.strictEqual(body.status, 'completed');
    assert.strictEqual(body.output_text, 'Hello from responses');
    assert.strictEqual(body.output[0].type, 'message');
    assert.strictEqual(body.output[0].content[0].type, 'output_text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint keeps context through previous_response_id', async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      prompts.push(requestBody.messages[0].content);
      const answer = prompts.length === 1 ? 'First answer' : 'Second answer';
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"choices": [{"delta": {"phase": "answer", "content": "${answer}"}}]}\n\n`));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const firstRes = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'First question'
      })
    }));
    assert.strictEqual(firstRes.status, 200);
    const first = await firstRes.json();
    assert.ok(first.id);
    assert.ok(first.conversation?.id);

    const secondRes = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        previous_response_id: first.id,
        input: 'Second question'
      })
    }));
    assert.strictEqual(secondRes.status, 200);
    const second = await secondRes.json();
    assert.strictEqual(second.previous_response_id, first.id);
    assert.strictEqual(second.conversation.id, first.conversation.id);
    assert.match(prompts[1], /First question/);
    assert.match(prompts[1], /First answer/);
    assert.match(prompts[1], /Second question/);

    const getRes = await app.fetch(new Request(`http://localhost/v1/responses/${first.id}`));
    assert.strictEqual(getRes.status, 200);
    const stored = await getRes.json();
    assert.strictEqual(stored.id, first.id);

    const itemsRes = await app.fetch(new Request(`http://localhost/v1/responses/${first.id}/input_items`));
    assert.strictEqual(itemsRes.status, 200);
    const items = await itemsRes.json();
    assert.strictEqual(items.object, 'list');
    assert.strictEqual(items.data[0].content[0].text, 'First question');

    await app.fetch(new Request(`http://localhost/v1/chats/${first.conversation.id}`, { method: 'DELETE' }));
    await app.fetch(new Request(`http://localhost/v1/responses/${first.id}`, { method: 'DELETE' }));
    await app.fetch(new Request(`http://localhost/v1/responses/${second.id}`, { method: 'DELETE' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint uses prompt_cache_key as stateless Codex session', async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      prompts.push(requestBody.messages[0].content);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response.created":{"response_id":"qwen-parent-id"}}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Answer"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const firstRes = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        prompt_cache_key: 'codex-thread-1',
        input: 'First question'
      })
    }));
    assert.strictEqual(firstRes.status, 200);
    const first = await firstRes.json();

    const secondRes = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        prompt_cache_key: 'codex-thread-1',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First question' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second question' }] }
        ]
      })
    }));
    assert.strictEqual(secondRes.status, 200);
    const second = await secondRes.json();
    assert.strictEqual(second.conversation.id, first.conversation.id);
    assert.strictEqual((prompts[1].match(/First question/g) || []).length, 1);
    assert.strictEqual((prompts[1].match(/Answer/g) || []).length, 1);
    assert.match(prompts[1], /Second question/);

    await app.fetch(new Request(`http://localhost/v1/chats/${first.conversation.id}`, { method: 'DELETE' }));
    await app.fetch(new Request(`http://localhost/v1/responses/${first.id}`, { method: 'DELETE' }));
    await app.fetch(new Request(`http://localhost/v1/responses/${second.id}`, { method: 'DELETE' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint rejects previous_response_id with conversation', async () => {
  const res = await app.fetch(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      previous_response_id: 'resp_previous',
      conversation: 'conv_existing',
      input: 'hello'
    })
  }));

  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error.param, 'previous_response_id');
});

test('Responses endpoint maps developer messages into the prompt', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      assert.ok(requestBody.messages[0].content.includes('Always use apply_patch for file edits.'));
      assert.ok(requestBody.messages[0].content.includes('User: Edit the file'));

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "ok"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Always use apply_patch for file edits.' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Edit the file' }] }
        ]
      })
    }));

    assert.strictEqual(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint supports /v1/chat/responses alias and function tools', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      assert.ok(requestBody.messages[0].content.includes('Use a tool'));
      assert.ok(requestBody.messages[0].content.includes('"name": "read_file"'));

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\"README.md\\"}}</tool_call>"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/chat/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Use a tool' }] }],
        tools: [{
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }]
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.object, 'response');
    assert.strictEqual(body.output[0].type, 'function_call');
    assert.strictEqual(body.output[0].name, 'read_file');
    assert.match(body.output[0].arguments, /README\.md/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint rewrites unsupported apply_patch tool calls to exec_command', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "<tool_call>{\\"name\\":\\"apply_patch\\",\\"arguments\\":{\\"patch\\":\\"*** Begin Patch\\\\n*** Add File: hello.txt\\\\n+hello\\\\n*** End Patch\\\\n\\"}}</tool_call>"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'Patch a file',
        tools: [{
          type: 'function',
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }]
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output[0].type, 'function_call');
    assert.strictEqual(body.output[0].name, 'exec_command');
    assert.match(body.output[0].arguments, /apply_patch/);
    assert.match(body.output[0].arguments, /hello\.txt/);
    assert.match(body.output[0].arguments, /PATCH/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint rewrites apply_patch path/content calls to patch command', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "<tool_call>{\\"name\\":\\"apply_patch\\",\\"arguments\\":{\\"path\\":\\"src/a.txt\\",\\"content\\":\\"one\\\\ntwo\\"}}</tool_call>"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'Patch a file',
        tools: [{
          type: 'function',
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }]
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output[0].name, 'exec_command');
    assert.match(body.output[0].arguments, /Delete File: src\/a\.txt/);
    assert.match(body.output[0].arguments, /Add File: src\/a\.txt/);
    assert.match(JSON.parse(body.output[0].arguments).cmd, /\n\+one\n\+two/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint emits Codex custom apply_patch calls for freeform tools', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      assert.ok(requestBody.messages[0].content.includes('"type": "custom"'));
      assert.ok(requestBody.messages[0].content.includes('"name": "apply_patch"'));

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "<tool_call>{\\"name\\":\\"apply_patch\\",\\"arguments\\":{\\"patch\\":\\"*** Begin Patch\\\\n*** Add File: hello.txt\\\\n+hello\\\\n*** End Patch\\\\n\\"}}</tool_call>"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'Patch a file',
        tools: [{
          type: 'custom',
          name: 'apply_patch',
          description: 'Use the apply_patch tool to edit files.',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: begin_patch hunk+ end_patch'
          }
        }]
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output[0].type, 'custom_tool_call');
    assert.strictEqual(body.output[0].name, 'apply_patch');
    assert.match(body.output[0].input, /Add File: hello\.txt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint maps Codex custom tool outputs back into chat history', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      assert.ok(requestBody.messages[0].content.includes('<tool_call>'));
      assert.ok(requestBody.messages[0].content.includes('Tool Response (apply_patch): ok'));

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Done"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Patch a file' }] },
          {
            type: 'custom_tool_call',
            call_id: 'call_patch',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n'
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch',
            name: 'apply_patch',
            output: 'ok'
          }
        ],
        tools: [{
          type: 'custom',
          name: 'apply_patch',
          description: 'Use the apply_patch tool to edit files.',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: begin_patch hunk+ end_patch'
          }
        }]
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output[0].type, 'message');
    assert.strictEqual(body.output_text, 'Done');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint injects default Codex tools when none are provided', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const rawBody = init?.body || (input instanceof Request ? await input.clone().text() : '{}');
      const requestBody = JSON.parse(rawBody as string);
      const prompt = requestBody.messages[0].content;
      assert.ok(prompt.includes('"name": "exec_command"'));
      assert.ok(prompt.includes('"name": "apply_patch"'));
      assert.ok(prompt.includes('"name": "multi_tool_use.parallel"'));

      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "<tool_call>{\\"name\\":\\"exec_command\\",\\"arguments\\":{\\"cmd\\":\\"pwd\\"}}</tool_call>"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        instructions: 'You are Codex and can use exec_command.',
        input: 'Check the current directory.'
      })
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.output[0].type, 'function_call');
    assert.strictEqual(body.output[0].name, 'exec_command');
    assert.match(body.output[0].arguments, /pwd/);
    assert.ok(body.tools.some((tool: any) => tool.name === 'exec_command'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses endpoint streams semantic response events', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hel"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const res = await app.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        input: 'Say hello',
        stream: true
      })
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const text = await res.text();
    assert.match(text, /event: response.created/);
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /"delta":"Hel"/);
    assert.match(text, /event: response.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  // Initialize playwright for this test
  await initPlaywright(false);

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
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

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { 'Authorization': 'Bearer wrong-key' }
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { 'Authorization': 'Bearer test-api-key' }
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  // Initialize playwright for this test
  await initPlaywright(false);

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('application/json'));

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.model, 'qwen3.6-plus');
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);
    
    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello non-stream');
    assert.strictEqual(choice.message.reasoning_content, 'Thinking non-stream...');
    assert.strictEqual(choice.finish_reason, 'stop');
    
    assert.ok(body.usage);
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens >= 0);
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});
