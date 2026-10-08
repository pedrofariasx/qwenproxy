import { test } from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'true';
process.env.USER_API_KEYS = 'sk-user-a:userOne,sk-user-b:userTwo';
delete process.env.API_KEY;

const { app } = await import('../../api/server.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
const { addAccount } = await import('../../core/accounts.js');

try { addAccount('test-mu-1@test.com', 'pass1', 'mu-test-account-1'); } catch { /* exists */ }
try { addAccount('test-mu-2@test.com', 'pass2', 'mu-test-account-2'); } catch { /* exists */ }
const {
  resolveUserFromAuthHeader,
  checkUserRateLimit,
  tryAcquireUserSlot,
  releaseUserSlot,
  getUserActiveStreams,
} = await import('../../core/user-manager.js');

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

function sseAnswer(content: string, responseId = 'rcon-x'): Response {
  const enc = new TextEncoder();
  let done = false;
  return new Response(new ReadableStream({
    pull(c) {
      if (done) { c.close(); return; }
      done = true;
      c.enqueue(enc.encode(`data: {"response.created":{"response_id":"${responseId}"}}\n\n`));
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(content)},"phase":"answer"}}],"usage":{"output_tokens":${content.length}}}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
    }
  }), { status: 200 });
}

function historyResponse(_lastUserContent: string, parentId: string): Response {
  // Server history synced UP TO the recorded parent: the last message is the
  // assistant reply we threaded onto (the client's new turn has not been sent).
  return new Response(JSON.stringify({
    success: true,
    data: {
      chat: {
        messages: [
          { id: 'u1', role: 'user', content: 'User: Turn 1' },
          { id: parentId, role: 'assistant', content: 'Reply 1', parentId: 'u1' },
        ],
      },
    },
  }), { status: 200 });
}

test('user-manager: resolves per-user and global identities', () => {
  process.env.API_KEY = '';
  const perUser = resolveUserFromAuthHeader('Bearer sk-user-a');
  assert.ok(perUser, 'env-seeded per-user key must resolve');
  assert.strictEqual(perUser!.id, 'userOne');
  assert.strictEqual(perUser!.isGlobal, false);

  process.env.API_KEY = 'global-secret';
  const global = resolveUserFromAuthHeader('Bearer global-secret');
  assert.ok(global);
  assert.strictEqual(global!.id, 'global');
  assert.strictEqual(global!.isGlobal, true);

  assert.strictEqual(resolveUserFromAuthHeader('Bearer nope'), null);
  assert.strictEqual(resolveUserFromAuthHeader(''), null);
  delete process.env.API_KEY;
});

test('user-manager: enforces per-user rate limits and concurrency caps', () => {
  const userId = 'userOne';
  // Rate limit: allow 2, then block.
  assert.strictEqual(checkUserRateLimit(userId, 2), true, '1st allowed');
  assert.strictEqual(checkUserRateLimit(userId, 2), true, '2nd allowed');
  assert.strictEqual(checkUserRateLimit(userId, 2), false, '3rd blocked');

  // Concurrency cap: allow 2, block the 3rd, re-allow after release.
  assert.strictEqual(tryAcquireUserSlot(userId, 2), true);
  assert.strictEqual(tryAcquireUserSlot(userId, 2), true);
  assert.strictEqual(tryAcquireUserSlot(userId, 2), false, 'at cap');
  assert.strictEqual(getUserActiveStreams(userId), 2);
  releaseUserSlot(userId);
  assert.strictEqual(tryAcquireUserSlot(userId, 2), true);
  releaseUserSlot(userId);
  releaseUserSlot(userId);
  assert.strictEqual(getUserActiveStreams(userId), 0);
});

test('session reconciliation: matching server history keeps economical mode', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];
  let first = true;

  const restore = setupFetchMock((url, init) => {
    if (url.includes('/api/v2/chats/') && !first) {
      // Turn 2: server history matches the client's conversation.
      return historyResponse('User: Turn 2', 'conv-ok');
    }
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
      first = false;
      return sseAnswer('Resposta completa para o teste.', 'conv-ok');
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'recon-match-chat';

    // Turn 1: bootstrap.
    const r1 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', user: 'conv-recon', messages: [{ role: 'user', content: 'Turn 1' }] })
    }));
    assert.strictEqual(r1.status, 200);
    await r1.text();

    // Turn 2: session verified against the server → economical (only last turn).
    const r2 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-recon',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Aa' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    }));
    assert.strictEqual(r2.status, 200);
    await r2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.ok(!capturedPayloads[1].messages[0].content.includes('Turn 1'), 'economical mode must be preserved when history matches');
    assert.ok(capturedPayloads[1].messages[0].content.includes('User: Turn 2'));
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});

test('session reconciliation: diverged server history forces a full re-bootstrap', async () => {
  resetAllSessions();
  const capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    if (url.includes('/api/v2/chats/')) {
      // Server last turn does NOT contain the client's last message → diverged.
      return historyResponse('User: Turn 2 EDITED BY USER ELSEWHERE', 'stale-parent');
    }
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
      return sseAnswer('Resposta completa para validar a divergencia.');
    }
    return new Response('{}', { status: 404 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-diverged-chat';

    const r1 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', user: 'conv-div', messages: [{ role: 'user', content: 'Turn 1' }] })
    }));
    assert.strictEqual(r1.status, 200);
    await r1.text();

    const r2 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        user: 'conv-div',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Aa' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    }));
    assert.strictEqual(r2.status, 200);
    await r2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.ok(capturedPayloads[1].messages[0].content.includes('Turn 1'), 'divergence must force the full conversation to be re-sent');
    assert.ok(capturedPayloads[1].messages[0].content.includes('User: Turn 2'));
  } finally {
    restore();
    delete process.env.TEST_SESSION_ID;
  }
});