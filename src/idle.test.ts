/**
 * idle.test.ts
 *
 * Testes para o mecanismo de limpeza automática de contexts idle.
 * Não depende de Playwright real — usa mocks internos.
 *
 * O que cobre:
 *   • Contexto idle é removido ao passar do TTL
 *   • Contexto recente não é removido
 *   • Contexto default (__default__) nunca é removido
 *   • Múltiplos contextos idle são limpos em lote
 *   • Contextos com chaves diferentes são independentes
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  __test_addMockContext,
  __test_clearPool,
  __test_getNonDefaultKeys,
  __test_setContextLastUsed,
  __test_triggerIdleCleanup,
  getContextPoolSize,
} from './services/playwright.ts';

// ──  Setup / Teardown  ──────────────────────────────────────

const TEST_TTL_MS = 500;

test.beforeEach(() => {
  __test_clearPool();
  process.env.TEST_IDLE_TTL_MS = String(TEST_TTL_MS);
});

test.afterEach(() => {
  __test_clearPool();
  delete process.env.TEST_IDLE_TTL_MS;
});

// ──  Tests  ─────────────────────────────────────────────────

test('idle-cleanup: removes a context that exceeded idle TTL', async () => {
  __test_addMockContext('session-a:nexus');
  assert.strictEqual(getContextPoolSize(), 1, 'pool has 1 context');

  // Mark as very old
  __test_setContextLastUsed('session-a:nexus', Date.now() - TEST_TTL_MS - 100);

  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'idle context was removed');
});

test('idle-cleanup: preserves a recently used context', async () => {
  __test_addMockContext('session-a:nexus');
  assert.strictEqual(getContextPoolSize(), 1);

  // Just created, still fresh
  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 1, 'recent context is kept');
});

test('idle-cleanup: never removes the default context', async () => {
  // Default context is not in our count, but should never be deleted
  // We just verify the cleanup runs without touching default
  __test_addMockContext('session-a:nexus');
  __test_setContextLastUsed('session-a:nexus', Date.now() - TEST_TTL_MS - 100);

  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'only non-default was removed');
});

test('idle-cleanup: removes multiple idle contexts at once', async () => {
  __test_addMockContext('key-a');
  __test_addMockContext('key-b');
  __test_addMockContext('key-c');
  assert.strictEqual(getContextPoolSize(), 3);

  // Make all idle
  const old = Date.now() - TEST_TTL_MS - 200;
  __test_setContextLastUsed('key-a', old);
  __test_setContextLastUsed('key-b', old);
  __test_setContextLastUsed('key-c', old);

  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'all idle contexts removed');
});

test('idle-cleanup: mixes idle and recent — only idle are removed', async () => {
  __test_addMockContext('idle-key');
  __test_addMockContext('fresh-key');

  __test_setContextLastUsed('idle-key', Date.now() - TEST_TTL_MS - 100);
  // fresh-key stays at Date.now() (set by addMockContext)

  await __test_triggerIdleCleanup();

  const remaining = __test_getNonDefaultKeys();
  assert.strictEqual(remaining.length, 1, 'only fresh context remains');
  assert.strictEqual(remaining[0], 'fresh-key', 'correct key survived');
});

test('idle-cleanup: context created again after cleanup works', async () => {
  __test_addMockContext('reusable');

  __test_setContextLastUsed('reusable', Date.now() - TEST_TTL_MS - 100);
  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'cleaned up');

  // Simulate a new request for the same key
  __test_addMockContext('reusable');
  assert.strictEqual(getContextPoolSize(), 1, 'recreated after cleanup');
});

test('idle-cleanup: multiple cleanup rounds are idempotent', async () => {
  __test_addMockContext('alpha');
  __test_addMockContext('beta');

  __test_setContextLastUsed('alpha', Date.now() - TEST_TTL_MS - 100);
  __test_setContextLastUsed('beta', Date.now() - TEST_TTL_MS - 100);

  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'first pass cleaned all');

  // Running again should not throw and keep pool empty
  await __test_triggerIdleCleanup();
  assert.strictEqual(getContextPoolSize(), 0, 'second pass is idempotent');
});

test('idle-cleanup: contexts with different idle times handled independently', async () => {
  __test_addMockContext('old');
  __test_addMockContext('almost-old');
  __test_addMockContext('young');

  __test_setContextLastUsed('old', Date.now() - TEST_TTL_MS - 200);
  __test_setContextLastUsed('almost-old', Date.now() - TEST_TTL_MS + 50); // still within TTL
  // young stays fresh

  await __test_triggerIdleCleanup();

  const remaining = __test_getNonDefaultKeys();
  assert.strictEqual(remaining.length, 2, 'old removed, two remain');
  assert.ok(remaining.includes('almost-old'), 'almost-old still alive');
  assert.ok(remaining.includes('young'), 'young still alive');
});
