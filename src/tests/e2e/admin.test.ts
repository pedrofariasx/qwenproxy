import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.ADMIN_PASSWORD = 'admin-test-secret';
process.env.HYBRID_SESSION_VERIFY = 'false';
delete process.env.API_KEY;

// Send the env-settings module to a temp file so tests never touch the real .env.
const TMP_ENV = path.join(os.tmpdir(), `qwenproxy-admin-test-${process.pid}.env`);
process.env.QWENPROXY_ENV_FILE = TMP_ENV;
fs.writeFileSync(TMP_ENV, 'PORT=3000\n# comment\nHEADLESS=true\nWARM_POOL_SIZE=2\n');

const { app } = await import('../../api/server.js');

function cookieFrom(res: Response): string {
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/^([^=]+)=([^;]*)/);
  return m ? `${m[1]}=${m[2]}` : '';
}

async function authedFetch(pathname: string, opts?: RequestInit, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return app.fetch(new Request(`http://localhost${pathname}`, {
    ...opts,
    headers: { ...headers, ...(opts?.headers || {}) },
  }));
}

test('admin: login requires password and issues a cookie', async () => {
  const bad = await authedFetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.strictEqual(bad.status, 401);

  const good = await authedFetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-test-secret' }),
  });
  assert.strictEqual(good.status, 200);
  assert.ok(good.headers.get('set-cookie')?.includes('qadmin='));
});

test('admin: unauthorized APIs return 401 without cookie', async () => {
  const res = await authedFetch('/admin/api/overview');
  assert.strictEqual(res.status, 401);
});

test('admin: overview, accounts, users and settings APIs work with cookie', async () => {
  const login = await authedFetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-test-secret' }),
  });
  const cookie = cookieFrom(login);

  const overview = await authedFetch('/admin/api/overview', undefined, cookie);
  assert.strictEqual(overview.status, 200);
  const o = await overview.json() as any;
  assert.ok('requestsTotal' in o && 'accounts' in o && 'users' in o && 'sessionCount' in o);

  const accounts = await authedFetch('/admin/api/accounts', undefined, cookie);
  assert.strictEqual(accounts.status, 200);

  const users = await authedFetch('/admin/api/users', undefined, cookie);
  assert.strictEqual(users.status, 200);

  const settings = await authedFetch('/admin/api/settings', undefined, cookie);
  assert.strictEqual(settings.status, 200);
  const s = await settings.json() as any;
  assert.ok(Array.isArray(s.allowlist) && s.allowlist.includes('PORT'));
  assert.strictEqual(s.settings.WARM_KEY_SIZE ?? undefined, undefined); // non-allowlisted keys not exposed
});

test('admin: account CRUD endpoints mutate the account store', async () => {
  const login = await authedFetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-test-secret' }),
  });
  const cookie = cookieFrom(login);

  const created = await authedFetch('/admin/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin-test-account@example.com', password: 'pw123' }),
  }, cookie);
  assert.strictEqual(created.status, 200);
  const createdBody = await created.json() as any;
  assert.ok(createdBody.account?.id);

  const list = await authedFetch('/admin/api/accounts', undefined, cookie);
  const accounts = (await list.json() as any).accounts as any[];
  assert.ok(accounts.some(a => a.email === 'admin-test-account@example.com'));

  const del = await authedFetch(`/admin/api/accounts/${createdBody.account.id}`, { method: 'DELETE' }, cookie);
  assert.strictEqual(del.status, 200);
});

test('admin: user CRUD endpoints manage api keys', async () => {
  const login = await authedFetch('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'admin-test-secret' }),
  });
  const cookie = cookieFrom(login);

  const created = await authedFetch('/admin/api/users', {
    method: 'POST',
    body: JSON.stringify({ email: 'ops-admin', apiKey: 'sk-admin-user-1', rateLimitRpm: 5, maxConcurrency: 2 }),
  }, cookie);
  assert.strictEqual(created.status, 200);

  const users = await authedFetch('/admin/api/users', undefined, cookie);
  const list = await users.json() as any[];
  const user = list.find(u => u.email === 'ops-admin');
  assert.ok(user, 'created user must be listed');
  assert.strictEqual(user.rateLimitRpm, 5);
  assert.strictEqual(user.maxConcurrency, 2);

  const del = await authedFetch(`/admin/api/users/${user.id}`, { method: 'DELETE' }, cookie);
  assert.strictEqual(del.status, 200);
});

test('env-settings: persistEnvPatch writes allowlisted keys to the env file', async () => {
  const { persistEnvPatch, readEnvFile, SETTINGS_ALLOWLIST } = await import('../../core/env-settings.js');

  const applied = persistEnvPatch({ PORT: '3100', HEADLESS: 'false', API_KEY: 'should-not-write' });
  assert.ok(applied.includes('PORT'));
  assert.ok(applied.includes('HEADLESS'));
  assert.ok(!applied.includes('API_KEY'), 'secret/locked keys must never be written');

  const read = readEnvFile();
  assert.strictEqual(read.PORT, '3100');
  assert.strictEqual(read.HEADLESS, 'false');
  assert.strictEqual(read.API_KEY, undefined);
  assert.strictEqual(read.ACCESSIBLE_EXCLUDED, undefined);
  assert.ok(SETTINGS_ALLOWLIST.has('PORT'));

  // Cleanup:
  fs.writeFileSync(TMP_ENV, 'PORT=4000\nHEADLESS=true\nWARM_KEY=2\n');
});