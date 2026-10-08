import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-account-recovery-'));
process.chdir(directory);
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { recoverUnreadyAccounts } = await import('../../services/session-keeper.js');
const { markAccountReady, markAccountNotReady, isAccountReady, markAccountRateLimited, clearAccountCooldown, markAccountStreamStart, markAccountStreamEnd } = await import('../../core/account-manager.js');
const { config } = await import('../../core/config.js');
const { makeAccountLaneId } = await import('../../core/account-lanes.js');
const { getUiMutex, getOrLaunchBrowser, setBrowser, accountPages, accountContexts, accountHeaderCaches, cookieCaches, cachedUserAgents, getAccountHeaderCache, initPlaywrightForAccount } = await import('../../services/browser-manager.js');
const { chromium } = await import('playwright');
const account = addAccount('recovery-fixture@example.test', 'fixture-password');

after(() => {
  closeDatabase();
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('account preparation recovers on a later pass after a transient DNS failure', async () => {
  let attempts = 0;
  const prepare = async () => {
    if (attempts++ === 0) throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED');
    markAccountReady(account.id);
  };
  await recoverUnreadyAccounts(prepare);
  assert.equal(isAccountReady(account.id), false);
  await recoverUnreadyAccounts(prepare);
  assert.equal(isAccountReady(account.id), true);
  await recoverUnreadyAccounts(prepare);
  assert.equal(attempts, 2, 'ready accounts must not be repeatedly logged in');
});

test('account recovery respects a cooldown and an active header capture', async () => {
  const other = addAccount('busy-fixture@example.test', 'fixture-password');
  let attempts = 0;
  markAccountRateLimited(other.id, 60000, 'fixture cooldown');
  await recoverUnreadyAccounts(async () => { attempts++; });
  assert.equal(attempts, 0);
  clearAccountCooldown(other.id);
  const release = await getUiMutex(other.id).acquire();
  try {
    await recoverUnreadyAccounts(async () => { attempts++; });
    assert.equal(attempts, 0);
  } finally {
    release();
  }
});

test('account recovery does not replace a context used by a pinned stream', async () => {
  const busy = addAccount('streaming-fixture@example.test', 'fixture-password');
  const slot = markAccountStreamStart(busy.id);
  const attempted: string[] = [];
  try {
    await recoverUnreadyAccounts(async entry => { attempted.push(entry.id); });
    assert.ok(!attempted.includes(busy.id));
  } finally {
    markAccountStreamEnd(busy.id, slot);
    markAccountReady(busy.id);
  }
});

test('single-account recovery prepares only unready lanes of the selected account', async () => {
  const selected = addAccount('lanes-fixture@example.test', 'fixture-password');
  const original = { ...config.accounts };
  const first = makeAccountLaneId(selected.id, 1);
  const second = makeAccountLaneId(selected.id, 2);
  try {
    Object.assign(config.accounts, { singleAccountMode: true, singleAccountId: selected.id, lanes: 2 });
    markAccountReady(first);
    const attempted: string[] = [];
    await recoverUnreadyAccounts(async entry => {
      attempted.push(entry.id);
      markAccountReady(entry.id);
    });
    assert.deepEqual(attempted, [second]);
  } finally {
    Object.assign(config.accounts, original);
    markAccountNotReady(first);
    markAccountNotReady(second);
    markAccountReady(selected.id);
  }
});

test('browser disconnection clears readiness for every closed account page', async t => {
  const pageId = 'disconnected-fixture';
  let disconnect: (() => void) | undefined;
  t.mock.method(chromium, 'launch', async () => ({
    on: (event: string, callback: () => void) => { if (event === 'disconnected') disconnect = callback; },
  }));
  setBrowser(null);
  await getOrLaunchBrowser();
  accountPages.set(pageId, {} as Page);
  markAccountReady(pageId);
  try {
    assert.ok(disconnect);
    disconnect();
    assert.equal(isAccountReady(pageId), false);
  } finally {
    setBrowser(null);
    accountPages.delete(pageId);
    markAccountNotReady(pageId);
  }
});

test('lane authentication confirms the base email instead of the lane label', async () => {
  const base = addAccount('lane-auth-fixture@example.test', 'fixture-password');
  const laneId = makeAccountLaneId(base.id, 1);
  const token = `fixture.${Buffer.from(JSON.stringify({ type: 'access_token', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  const context = {
    addInitScript: async () => {},
    cookies: async () => [{ name: 'token', value: 'fixture-cookie' }],
    storageState: async () => ({ cookies: [], origins: [{ origin: 'https://chat.qwen.ai', localStorage: [{ name: 'token', value: token }] }] }),
    newPage: async () => page,
  };
  const page = {
    context: () => context,
    goto: async () => {},
    reload: async () => {},
    locator: () => ({ count: async () => 0 }),
    waitForFunction: async () => {},
    waitForResponse: async (predicate: (response: unknown) => Promise<boolean>) => {
      const response = {
        url: () => 'https://auth.qwen.ai/api/v2/auths/',
        ok: () => true,
        json: async () => ({ success: true, data: { id: 'fixture-user', email: base.email } }),
      };
      assert.equal(await predicate(response), true, 'the actual account email must match');
      return response;
    },
    evaluate: async () => { throw new Error('Valid saved session must not need another login'); },
  };
  setBrowser({ isConnected: () => true, newContext: async () => context } as unknown as Browser);
  try {
    await initPlaywrightForAccount({ ...base, id: laneId, email: `${base.email}#lane-1` });
  } finally {
    setBrowser(null);
    accountContexts.delete(laneId);
    accountPages.delete(laneId);
  }
});

for (const stage of ['init-script', 'new-page', 'storage', 'navigation', 'rejected-login', 'unconfirmed-session', 'missing-credentials', 'close-error'] as const) {
  test(`account setup failure at ${stage} closes and unregisters the context`, async () => {
    const fixture = addAccount(`${stage}@example.test`, stage === 'missing-credentials' ? '' : 'fixture-password');
    const needsLogin = stage === 'rejected-login';
    const token = `fixture.${Buffer.from(JSON.stringify({ type: 'access_token', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    let closes = 0;
    const context = {
      addInitScript: async () => { if (stage === 'init-script') throw new Error('Fixture init script failed'); },
      newPage: async () => { if (stage === 'new-page') throw new Error('Fixture page creation failed'); return page; },
      cookies: async () => needsLogin ? [] : [{ name: 'token', value: 'fixture-cookie' }],
      storageState: async () => {
        if (stage === 'storage') throw new Error('Fixture storage failed');
        return { cookies: [], origins: needsLogin ? [] : [{ origin: 'https://chat.qwen.ai', localStorage: [{ name: 'token', value: token }] }] };
      },
      close: async () => { closes++; if (stage === 'close-error') throw new Error('Fixture context close failed'); },
    };
    const page = {
      context: () => context,
      goto: async () => { if (stage === 'navigation') throw new Error('Fixture navigation failed'); },
      reload: async () => {},
      locator: () => ({ count: async () => 0 }),
      waitForFunction: async () => {},
      waitForResponse: async () => { throw new Error('Fixture session not confirmed'); },
      evaluate: async () => ({ ok: true, data: { success: false } }),
    };
    setBrowser({ isConnected: () => true, newContext: async () => context } as unknown as Browser);
    getAccountHeaderCache(fixture.id);
    cookieCaches.set(fixture.id, { cookie: 'fixture-cookie', timestamp: Date.now() });
    cachedUserAgents.set(fixture.id, 'fixture-agent');
    markAccountReady(fixture.id);
    try {
      const expected = {
        'init-script': /Fixture init script failed/,
        'new-page': /Fixture page creation failed/,
        storage: /Fixture storage failed/,
        navigation: /Fixture navigation failed/,
        'rejected-login': /Qwen rejected account login/,
        'unconfirmed-session': /Qwen rejected account login/,
        'missing-credentials': /no login credentials were provided/,
        'close-error': /Qwen rejected account login/,
      }[stage];
      await assert.rejects(initPlaywrightForAccount(fixture), expected);
      assert.equal(closes, 1, 'every created context must be closed on setup failure');
      assert.equal(accountContexts.has(fixture.id), false);
      assert.equal(accountPages.has(fixture.id), false);
      assert.equal(accountHeaderCaches.has(fixture.id), false);
      assert.equal(cookieCaches.has(fixture.id), false);
      assert.equal(cachedUserAgents.has(fixture.id), false);
      assert.equal(isAccountReady(fixture.id), false);
    } finally {
      setBrowser(null);
      accountContexts.delete(fixture.id);
      accountPages.delete(fixture.id);
      accountHeaderCaches.delete(fixture.id);
      cookieCaches.delete(fixture.id);
      cachedUserAgents.delete(fixture.id);
      markAccountNotReady(fixture.id);
    }
  });
}
