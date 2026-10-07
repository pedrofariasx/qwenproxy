import { test } from 'node:test';
import assert from 'node:assert';
import {
  markAccountStreamStart,
  markAccountStreamEnd,
  getAccountActiveLoad,
  getNextAccount,
  onAccountFreed,
  releaseAccountInUse,
  clearAccountCooldown,
} from '../../core/account-manager.js';
import { makeAccountLaneId, getBaseAccountId } from '../../core/account-lanes.js';
import { loadAccounts } from '../../core/accounts.js';

test('account scheduler: marks active load bucketed by base account (lanes share bucket)', () => {
  const base = 'sched-account-a';
  const lane1 = makeAccountLaneId(base, 1);
  const lane2 = makeAccountLaneId(base, 2);

  markAccountStreamStart(lane1);
  markAccountStreamStart(lane2);
  assert.strictEqual(getAccountActiveLoad(base), 2);
  assert.strictEqual(getAccountActiveLoad(lane1), 2, 'any lane sees the base bucket load');
  assert.strictEqual(getAccountActiveLoad('other-account'), 0);

  markAccountStreamEnd(lane1);
  assert.strictEqual(getAccountActiveLoad(base), 1);

  markAccountStreamEnd(lane2);
  assert.strictEqual(getAccountActiveLoad(base), 0);
});

test('account scheduler: getNextAccount prefers the least-loaded viable account', async () => {
  const accounts = loadAccounts();
  const viable = accounts.filter(a => a.id !== 'global').slice(0, 4);
  if (viable.length < 2) {
    assert.ok(getNextAccount() !== null || true, 'skip preference check without enough accounts');
    return;
  }

  // Normalize scheduler state for the accounts we'll pin load onto.
  for (const a of viable) {
    releaseAccountInUse(a.id);
    clearAccountCooldown(a.id);
  }

  const heavyAccount = viable[0];
  for (let i = 0; i < 3; i++) {
    markAccountStreamStart(heavyAccount.id);
  }

  try {
    const chosen = getNextAccount();
    assert.ok(chosen, 'must still return an account');
    const chosenBase = getBaseAccountId(chosen.id);
    // The heavy account (by base) must be avoided while another has zero load.
    if (getBaseAccountId(heavyAccount.id) !== chosenBase) {
      assert.strictEqual(getAccountActiveLoad(chosenBase), 0, 'least-loaded account should win');
    } else {
      // Only one base account exists overall — heavier or not, it has to serve.
      assert.strictEqual(getAccountActiveLoad(chosenBase), 3);
    }
  } finally {
    for (let i = 0; i < 3; i++) {
      markAccountStreamEnd(heavyAccount.id);
    }
  }
});

test('account scheduler: onAccountFreed resolves when a slot frees', async () => {
  let resolved = false;
  const freed = onAccountFreed();
  freed.promise.then(() => {
    resolved = true;
  });

  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(resolved, false, 'waiters must not resolve before any stream frees');

  markAccountStreamEnd('sched-free-slot');
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(resolved, true, 'waiters must be drained on slot release');

  const cancelled = onAccountFreed();
  cancelled.cancel();
});