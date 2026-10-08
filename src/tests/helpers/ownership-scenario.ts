import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenario = process.argv[2];
const cwd = process.cwd();
const restored = process.env.QWEN_OWNERSHIP_FIXTURE_DIR;
assert.ok(!restored || path.resolve(restored).startsWith(path.join(os.tmpdir(), 'qwen-ownership-')));
const directory = restored || fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ownership-'));
process.chdir(directory);
process.env.API_KEY = ['global', 'mixed', 'same-client-key', 'aliases-and-tools', 'foreign-stop', 'key-rotation', 'namespace-collisions', 'persistence', 'restart-check'].includes(scenario) ? 'fixture-global' : '';
process.env.USER_API_KEYS = ['env-only', 'env-only-required', 'mixed', 'env-key-rotation'].includes(scenario) ? 'fixture-env:env-user' : '';
process.env.AUTH_REQUIRED = ['required-without-keys', 'db-only-required', 'env-only-required'].includes(scenario) ? 'true' : 'false';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.TEST_MOCK_PLAYWRIGHT = 'true';
delete process.env.TEST_SESSION_ID;
let legacySnapshot: { accounts: unknown; users: unknown; sessions: unknown; key: string } | undefined;
if (scenario === 'legacy-migration') {
  fs.mkdirSync('data');
  const { encrypt } = await import('../../core/crypto-utils.js');
  const legacy = new Database('data/qwenproxy.db');
  legacy.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, api_key TEXT UNIQUE NOT NULL, rate_limit_rpm INTEGER NOT NULL DEFAULT 0, max_concurrency INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE sessions (session_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, account_id TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', parent_id TEXT, history_complete INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
  `);
  for (let i = 0; i < 3; i++) legacy.prepare('INSERT INTO accounts (id,email,password) VALUES (?,?,?)').run(`legacy-account-${i}`, `legacy-${i}@example.invalid`, encrypt('fixture-password'));
  legacy.prepare('INSERT INTO users (id,email,api_key) VALUES (?,?,?)').run('alice', 'alice@example.invalid', 'fixture-alice');
  for (let i = 0; i < 16; i++) legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(`legacy-client-${i}`, `legacy-chat-${i}`, 'legacy-account-0', JSON.stringify({ cookie: 'fixture-cookie' }), `legacy-parent-${i}`, 1, 0);
  legacySnapshot = { accounts: legacy.prepare('SELECT id,email,password FROM accounts ORDER BY id').all(), users: legacy.prepare('SELECT * FROM users ORDER BY id').all(), sessions: legacy.prepare('SELECT * FROM sessions ORDER BY session_key').all(), key: fs.readFileSync('data/.encryption_key', 'utf8') };
  legacy.close();
}
if (scenario === 'migration-conflict') {
  fs.mkdirSync('data');
  const legacy = new Database('data/qwenproxy.db');
  legacy.exec("CREATE TABLE sessions (session_key TEXT PRIMARY KEY, chat_id TEXT NOT NULL, account_id TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', parent_id TEXT, history_complete INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, owner TEXT);");
  for (const owner of ['alice', 'bob']) legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run(owner, 'duplicate-owned-chat', 'fixture', '{}', null, 1, Date.now(), JSON.stringify(['user', owner]));
  legacy.close();
}
const { app } = await import('../../api/server.js');
const dbModule = await import('../../core/database.js');
const { upsertUser, listSessions, closeDatabase, getDatabase } = dbModule;
const sessions = await import('../../services/session-manager.js');
const { addAccount } = await import('../../core/accounts.js');
if (['db-only', 'db-only-required', 'mixed', 'same-client-key', 'aliases-and-tools', 'foreign-stop', 'key-rotation', 'persistence'].includes(scenario)) {
  upsertUser({ id: 'alice', email: 'alice@example.invalid', apiKey: 'fixture-alice' });
  upsertUser({ id: 'bob', email: 'bob@example.invalid', apiKey: 'fixture-bob' });
}
app.get('/v1/identity-fixture', c => c.json({ user: (c as any).get('user') ?? null, principal: (c as any).get('principal') ?? null }));
const nativeFetch = globalThis.fetch;
const payloads: any[] = [];
let providerStops = 0;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname !== 'chat.qwen.ai') throw new Error('Unexpected network destination in ownership fixture');
  if (url.includes('/completions/stop')) { providerStops++; return Response.json({ success: true }); }
  if (url.includes('/completions?')) {
    payloads.push(JSON.parse(String(init?.body)));
    const answer = 'The controlled request completed successfully. It produced a deterministic answer for the authorization fixture, without contacting a real provider or reading account data.';
    return new Response('data: ' + JSON.stringify({ 'response.created': { response_id: `fixture-response-${payloads.length}` } }) + '\n\n'
      + 'data: ' + JSON.stringify({ response_id: `fixture-response-${payloads.length}`, choices: [{ delta: { content: answer, phase: 'answer' }, finish_reason: 'stop' }] }) + '\n\n'
      + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return Response.json({ success: true });
};
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function request(route: string, token?: string, body?: unknown) {
  return nativeFetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function chat(token: string, key: string, messages = [{ role: 'user', content: 'A controlled request.' }]) {
  const response = await request('/v1/chat/completions', token, { model: 'qwen3.7-plus', user: key, stream: false, messages });
  const body = await response.json();
  return { response, body };
}
try {
  if (['global', 'env-only', 'env-only-required', 'db-only', 'db-only-required', 'mixed', 'required-without-keys', 'anonymous'].includes(scenario)) {
    const tokens = scenario === 'global' ? ['fixture-global'] : scenario.startsWith('env-only') ? ['fixture-env']
      : scenario.startsWith('db-only') ? ['fixture-alice'] : scenario === 'mixed' ? ['fixture-global', 'fixture-env', 'fixture-alice'] : [];
    for (const token of tokens) {
      const response = await request('/v1/identity-fixture', token);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.user);
      assert.equal(typeof body.principal, 'string');
    }
    const absent = await request('/v1/identity-fixture');
    assert.equal(absent.status, scenario === 'anonymous' ? 200 : scenario === 'required-without-keys' ? 500 : 401);
    if (scenario === 'anonymous') assert.equal(typeof (await absent.json()).principal, 'string');
    assert.equal((await request('/v1/identity-fixture', 'fixture-unknown')).status, scenario === 'required-without-keys' ? 500 : 401);
  } else if (scenario === 'same-client-key' || scenario === 'key-rotation' || scenario === 'aliases-and-tools' || scenario === 'persistence') {
    addAccount('qwen-fixture@example.invalid', 'fixture', 'fixture-account');
    const first = await chat('fixture-alice', 'shared-client-key');
    assert.equal(first.response.status, 200);
    const aliceRow = listSessions()[0];
    const aliceSnapshot = JSON.stringify(aliceRow);
    if (scenario === 'same-client-key') {
      assert.equal((await chat('fixture-bob', 'shared-client-key')).response.status, 200);
      assert.equal(payloads.length, 2);
      assert.notEqual(payloads[0].chat_id, payloads[1].chat_id);
      assert.equal(listSessions().length, 2);
      assert.equal(JSON.stringify(listSessions().find(row => row.chat_id === aliceRow.chat_id)), aliceSnapshot);
    } else if (scenario === 'aliases-and-tools') {
      const { recordToolCallEmission } = await import('../../core/tool-call-registry.js');
      recordToolCallEmission(aliceRow.chat_id, 'foreign-call', 'fixture_tool', '{}');
      const before = payloads.length;
      assert.equal((await chat('fixture-bob', aliceRow.chat_id)).response.status, 403);
      assert.equal((await chat('fixture-bob', aliceRow.chat_id, [{ role: 'tool', content: 'fixture foreign result', tool_call_id: 'foreign-call' } as any])).response.status, 403);
      assert.equal((await chat('fixture-bob', 'bob-tool-session', [{ role: 'tool', content: 'fixture foreign result', tool_call_id: 'foreign-call' } as any])).response.status, 400);
      assert.equal(payloads.length, before);
      assert.equal(JSON.stringify(listSessions()[0]), aliceSnapshot);
      assert.equal((await chat('fixture-alice', aliceRow.chat_id)).response.status, 200);
      assert.equal(payloads.at(-1).chat_id, aliceRow.chat_id);
      assert.equal((await chat('fixture-alice', aliceRow.chat_id, [{ role: 'tool', content: 'fixture own result', tool_call_id: 'foreign-call' } as any])).response.status, 200);
    } else if (scenario === 'persistence') {
      closeDatabase();
      const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'restart-check'], { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, QWEN_OWNERSHIP_FIXTURE_DIR: directory, QWEN_OWNERSHIP_EXPECTED_CHAT: aliceRow.chat_id } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } else {
      upsertUser({ id: 'alice', email: 'alice@example.invalid', apiKey: 'fixture-alice-rotated' });
      assert.equal((await chat('fixture-alice-rotated', 'shared-client-key')).response.status, 200);
      assert.equal(payloads.at(-1).chat_id, aliceRow.chat_id);
      assert.equal((await request('/v1/identity-fixture', 'fixture-alice')).status, 401);
    }
  } else if (scenario === 'foreign-stop') {
    const registry = await import('../../core/stream-registry.js');
    const alice = await (await request('/v1/identity-fixture', 'fixture-alice')).json();
    const abort = new AbortController();
    registry.registerStream('fixture-completion', { abortController: abort, accountId: 'fixture-account', uiSessionId: 'fixture-chat',
      targetResponseId: 'fixture-response', headers: {}, stopToken: 'fixture-stop-token', ...{ owner: alice.principal } });
    const stopped = await request('/v1/chat/completions/stop', 'fixture-bob', { completion_id: 'fixture-completion', chat_id: 'fixture-completion', response_id: 'fixture-response', stop_token: 'fixture-stop-token' });
    assert.equal(stopped.status, 403);
    assert.equal(providerStops, 0);
    assert.equal(abort.signal.aborted, false);
    assert.ok(registry.getStream('fixture-completion'));
    assert.equal((await request('/v1/chat/completions/stop', 'fixture-alice', { completion_id: 'fixture-completion', chat_id: 'fixture-completion', response_id: 'fixture-response', stop_token: 'fixture-stop-token' })).status, 200);
    assert.equal(providerStops, 1);
    assert.equal(abort.signal.aborted, true);
  } else if (scenario === 'legacy-migration') {
    let db = getDatabase();
    assert.ok((db.prepare('PRAGMA table_info(sessions)').all() as {name: string}[]).some(row => row.name === 'owner'));
    assert.deepEqual(db.prepare('SELECT id,email,password FROM accounts ORDER BY id').all(), legacySnapshot!.accounts);
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), legacySnapshot!.users);
    assert.deepEqual(db.prepare('SELECT session_key,chat_id,account_id,headers,parent_id,history_complete,updated_at FROM sessions ORDER BY session_key').all(), legacySnapshot!.sessions);
    assert.equal(listSessions().length, 16);
    assert.ok(listSessions().every(row => row.owner === null));
    assert.equal(fs.readFileSync('data/.encryption_key', 'utf8'), legacySnapshot!.key);
    assert.equal(sessions.getSession('legacy-client-0')?.parentId, 'legacy-parent-0');
    assert.equal(listSessions().length, 16, 'Old unassigned rows must not expire during migration');
    closeDatabase(); db = getDatabase();
    assert.equal((db.prepare('PRAGMA table_info(sessions)').all() as {name: string}[]).filter(row => row.name === 'owner').length, 1);
    assert.equal((await chat('fixture-alice', 'legacy-chat-0')).response.status, 403);
    assert.equal(payloads.length, 0);
    assert.equal((await chat('fixture-alice', 'legacy-client-0')).response.status, 200);
    assert.equal(listSessions().length, 17);
    assert.deepEqual(db.prepare('SELECT session_key,chat_id,account_id,headers,parent_id,history_complete,updated_at FROM sessions WHERE owner IS NULL ORDER BY session_key').all(), legacySnapshot!.sessions);
  } else if (scenario === 'restart-check') {
    const expected = process.env.QWEN_OWNERSHIP_EXPECTED_CHAT!;
    assert.equal((await chat('fixture-bob', expected)).response.status, 403);
    assert.equal(payloads.length, 0);
    assert.equal((await chat('fixture-alice', expected)).response.status, 200);
    assert.equal(payloads[0].chat_id, expected);
  } else if (scenario === 'namespace-collisions') {
    const { config } = await import('../../core/config.js');
    config.users.apiKeys = 'fixture-env-global:global';
    upsertUser({ id: 'global', apiKey: 'fixture-db-global', rateLimitRpm: 1 });
    addAccount('namespace@example.invalid', 'fixture', 'namespace-account');
    for (const token of ['fixture-global', 'fixture-db-global', 'fixture-env-global']) {
      assert.equal((await chat(token, 'same:client:[key]')).response.status, 200);
    }
    assert.equal(new Set(payloads.map(payload => payload.chat_id)).size, 3);
    assert.equal(new Set(listSessions().map(row => row.owner)).size, 3);
    const foreignCanonical = listSessions()[0].session_key;
    assert.equal((await chat('fixture-env-global', foreignCanonical)).response.status, 200);
    assert.notEqual(payloads.at(-1).chat_id, payloads[0].chat_id);
    assert.equal(listSessions().at(-1)?.owner, JSON.stringify(['environment', 'global']));
  } else if (scenario === 'env-key-rotation') {
    addAccount('env-rotation@example.invalid', 'fixture', 'env-rotation-account');
    assert.equal((await chat('fixture-env', 'env-client')).response.status, 200);
    const before = listSessions()[0];
    const { config } = await import('../../core/config.js');
    config.users.apiKeys = 'fixture-env-rotated:env-user';
    assert.equal((await chat('fixture-env-rotated', 'env-client')).response.status, 200);
    assert.equal(payloads.at(-1).chat_id, before.chat_id);
    assert.equal((await request('/v1/identity-fixture', 'fixture-env')).status, 401);
    assert.equal((getDatabase().prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, 0);
  } else if (scenario === 'storage-guard') {
    const owner = JSON.stringify(['user', 'alice']);
    const entry = { chatId: 'guard-chat', accountId: 'fixture', headers: {}, parentId: 'owned-parent', historyComplete: true, updatedAt: Date.now(), owner };
    sessions.setSession('guard-key', entry);
    const before = JSON.stringify(listSessions()[0]);
    assert.throws(() => sessions.setSession('guard-key', { ...entry, owner: JSON.stringify(['user', 'bob']) }));
    assert.equal(JSON.stringify(listSessions()[0]), before);
    assert.throws(() => dbModule.upsertSession({ session_key: 'duplicate-owned', chat_id: entry.chatId, account_id: 'fixture', headers: '{}', parent_id: null, history_complete: 1, updated_at: Date.now(), owner: JSON.stringify(['user', 'bob']) }), /UNIQUE/);
    dbModule.upsertSession({ session_key: 'legacy-duplicate', chat_id: entry.chatId, account_id: 'fixture', headers: '{}', parent_id: 'legacy-parent', history_complete: 1, updated_at: Date.now() });
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'alias-restoration-check'], { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, QWEN_OWNERSHIP_FIXTURE_DIR: directory } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    getDatabase().exec("CREATE TRIGGER fixture_insert_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END;");
    assert.throws(() => sessions.setSession('failed-key', { ...entry, chatId: 'failed-chat' }));
    assert.equal(sessions.getSession('failed-key'), undefined);
    assert.equal(sessions.resolveSessionKey('failed-chat'), undefined);
  } else if (scenario === 'alias-restoration-check') {
    const owner = JSON.stringify(['user', 'alice']);
    assert.equal(sessions.resolveOwnedSessionKey(owner, 'guard-chat'), 'guard-key');
    assert.equal(sessions.getSessionParent('guard-chat'), 'owned-parent');
    sessions.removeSession('legacy-duplicate');
    assert.equal(sessions.resolveOwnedSessionKey(owner, 'guard-chat'), 'guard-key');
    assert.equal(sessions.getSessionParent('guard-chat'), 'owned-parent');
  } else if (scenario === 'migration-conflict') {
    assert.throws(() => getDatabase(), /UNIQUE/);
    assert.throws(() => getDatabase(), /UNIQUE/, 'A failed schema initialization must not be reused');
  } else if (scenario === 'env-whitespace') {
    const { config } = await import('../../core/config.js');
    config.users.apiKeys = ' fixture-spaced : alice , : ignored, fixture-label-only: alice';
    for (const key of ['fixture-spaced', 'fixture-label-only']) {
      const response = await request('/v1/identity-fixture', key);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).principal, JSON.stringify(['environment', 'alice']));
    }
    config.users.apiKeys = ' fixture-unlabelled :  ';
    const unlabelled = await request('/v1/identity-fixture', 'fixture-unlabelled');
    assert.equal(unlabelled.status, 200);
    assert.equal((await unlabelled.json()).principal, JSON.stringify(['environment', 'env-db150674b3dc9017f1899568fa02601c30dfe5fb429646c986e1c4840fbeae02']));
    config.users.apiKeys = ' : ignored';
    const anonymous = await request('/v1/identity-fixture');
    assert.equal(anonymous.status, 200);
    assert.equal((await anonymous.json()).principal, JSON.stringify(['anonymous']));
  }
  console.log(JSON.stringify({ scenario, status: 'pass', provider_posts: payloads.length }));
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase();
  process.chdir(cwd);
  if (!restored) fs.rmSync(directory, { recursive: true, force: true });
}
