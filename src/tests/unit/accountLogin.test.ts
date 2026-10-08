import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { getActivePage, loginToQwen, setActivePage } from '../../services/browser-manager.ts';

async function runLogin(payload: unknown, sessionConfirmed = true) {
  const values = new Map<string, string>([['qwen_token_logged_out_marker', 'old']]);
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalPage = getActivePage();
  let currentUrl = 'about:blank';
  let beforeChat: Record<string, string> | undefined;
  const page = {
    context: () => ({}),
    goto: async (url: string) => {
      if (url === 'https://chat.qwen.ai/') beforeChat = Object.fromEntries(values);
      currentUrl = url;
    },
    url: () => currentUrl,
    evaluate: async (callback: (value: unknown) => unknown, value: unknown) => callback(value),
    waitForFunction: async () => undefined,
    waitForResponse: async (predicate: (response: unknown) => Promise<boolean>) => {
      const response = {
        url: () => 'https://auth.qwen.ai/api/v2/auths/',
        ok: () => true,
        json: async () => ({ success: sessionConfirmed, data: { id: 'fixture-user', email: 'fixture@example.test' } }),
      };
      if (!await predicate(response)) throw new Error('Browser session was rejected');
      return response;
    },
    reload: async () => undefined,
  } as unknown as Page;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    setActivePage(page);
    const accepted = await loginToQwen('fixture@example.test', 'fixture-password');
    return { accepted, beforeChat, values };
  } finally {
    setActivePage(originalPage);
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('successful login supplies browser authentication before opening the chat', async () => {
  const result = await runLogin({
    success: true,
    data: { id: 'fixture-user', token: 'fixture-access-token', expires_at: 1893456000 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.beforeChat?.token, 'fixture-access-token');
  assert.equal(result.beforeChat?.at_expire_time, '1893456000000');
  assert.equal(result.beforeChat?.qwen_token_logged_out_marker, undefined);
  const state = JSON.parse(result.beforeChat?.qwen_access_token_state || '{}');
  assert.equal(state.token, 'fixture-access-token');
  assert.equal(state.expiresAt, 1893456000000);
});

test('HTTP 200 with a rejected login is not an authenticated account', async () => {
  const result = await runLogin({ success: false, data: { code: 'InvalidCredentials' } });
  assert.equal(result.accepted, false);
  assert.equal(result.beforeChat, undefined);
  assert.equal(result.values.get('token'), undefined);
});

test('a success envelope without an access token does not open an authenticated chat', async () => {
  const result = await runLogin({ success: true, data: { id: 'fixture-user' } });
  assert.equal(result.accepted, false);
  assert.equal(result.beforeChat, undefined);
});

test('a successful sign-in is rejected when the browser account session is not confirmed', async () => {
  const result = await runLogin({
    success: true,
    data: { id: 'fixture-user', token: 'fixture-access-token', expires_at: 1893456000 },
  }, false);
  assert.equal(result.accepted, false);
});
