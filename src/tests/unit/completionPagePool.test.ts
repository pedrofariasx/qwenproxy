import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { acquireCompletionPage, releaseCompletionPage } from '../../services/completion-page-pool.js';
import { config } from '../../core/config.js';

function fakePage(context: object) {
  let closed = false;
  return {
    context: () => context,
    url: () => 'https://chat.qwen.ai/',
    isClosed: () => closed,
    close: async () => { closed = true; },
  } as unknown as Page;
}

test('only an idle page is reused and concurrent completions get distinct pages', async () => {
  const context = {};
  const base = fakePage(context);
  let created = 0;
  const create = async () => { created++; return fakePage(context); };
  const first = await acquireCompletionPage(base, create);
  await releaseCompletionPage(base, first, true);
  const leases = await Promise.all([acquireCompletionPage(base, create), acquireCompletionPage(base, create)]);
  assert.equal(leases[0], first);
  assert.notEqual(leases[0], leases[1]);
  assert.equal(created, 2);
  await releaseCompletionPage(base, leases[0], true);
  await releaseCompletionPage(base, leases[1], true);
  assert.equal(leases[1].isClosed(), true);
  const retained = await acquireCompletionPage(base, create);
  assert.equal(retained, first);
  await releaseCompletionPage(base, retained, false);
  assert.equal(retained.isClosed(), true);
  assert.equal(base.isClosed(), false);
});

test('page ownership stays with its base page and closed idle pages are discarded', async () => {
  const context = {};
  const firstBase = fakePage(context);
  const secondBase = fakePage(context);
  const first = await acquireCompletionPage(firstBase, async () => fakePage(context));
  await releaseCompletionPage(firstBase, first, true);
  const second = await acquireCompletionPage(secondBase, async () => fakePage(context));
  assert.notEqual(second, first);
  await releaseCompletionPage(secondBase, second, false);
  await first.close();
  const replacement = await acquireCompletionPage(firstBase, async () => fakePage(context));
  assert.notEqual(replacement, first);
  await firstBase.close();
  await releaseCompletionPage(firstBase, replacement, true);
  assert.equal(replacement.isClosed(), true);
});

test('idle expiry and a disabled cache close pages without retaining a lease', async () => {
  const ttl = config.completionPageIdleTtlMs;
  const context = {};
  const base = fakePage(context);
  try {
    config.completionPageIdleTtlMs = 15;
    const idle = await acquireCompletionPage(base, async () => fakePage(context));
    await releaseCompletionPage(base, idle, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(idle.isClosed(), true);
    config.completionPageIdleTtlMs = 0;
    const uncached = await acquireCompletionPage(base, async () => fakePage(context));
    await releaseCompletionPage(base, uncached, true);
    assert.equal(uncached.isClosed(), true);
  } finally { config.completionPageIdleTtlMs = ttl; }
});

test('an idle page is discarded when its owning base page has closed', async () => {
  const context = {};
  const base = fakePage(context);
  const idle = await acquireCompletionPage(base, async () => fakePage(context));
  await releaseCompletionPage(base, idle, true);
  await base.close();
  const replacement = await acquireCompletionPage(base, async () => fakePage(context));
  assert.notEqual(replacement, idle);
  assert.equal(idle.isClosed(), true);
  await releaseCompletionPage(base, replacement, true);
  assert.equal(replacement.isClosed(), true);
});
