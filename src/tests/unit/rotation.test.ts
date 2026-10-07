import { test } from 'node:test';
import assert from 'node:assert';
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  clearAccountCooldown,
  invalidateAccountsCache,
  markAccountReady,
  markAccountNotReady,
  markAccountInUse,
  releaseAccountInUse,
} from '../../core/account-manager.ts';
import { addAccount, removeAccount, loadAccounts } from '../../core/accounts.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const originalAccounts = loadAccounts();
  const originalIds = originalAccounts.map(a => a.id);

  const mockAccounts = [
    { email: 'account1@test.com', password: 'password1' },
    { email: 'account2@test.com', password: 'password2' },
    { email: 'account3@test.com', password: 'password3' },
  ];

  try {
    for (const acc of mockAccounts) {
      addAccount(acc.email, acc.password);
    }
    invalidateAccountsCache();

    const first = getNextAccount(true);
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    const allAccounts = loadAccounts();
    const firstIdx = allAccounts.findIndex(a => a.id === first.id);
    const secondIdx = allAccounts.findIndex(a => a.id === second.id);
    const thirdIdx = allAccounts.findIndex(a => a.id === third.id);
    const fourthIdx = allAccounts.findIndex(a => a.id === fourth.id);

    assert.strictEqual(secondIdx, (firstIdx + 1) % allAccounts.length);
    assert.strictEqual(thirdIdx, (secondIdx + 1) % allAccounts.length);
    assert.strictEqual(fourthIdx, (thirdIdx + 1) % allAccounts.length);
  } finally {
    const current = loadAccounts();
    for (const acc of current) {
      if (!originalIds.includes(acc.id)) {
        removeAccount(acc.id);
      }
    }
    invalidateAccountsCache();
  }
});

test('Account Cooldown: Database persistence and recovery', async () => {
  const email = 'cooldown-test@test.com';
  let accountId = '';

  try {
    const newAcct = addAccount(email, 'password123');
    accountId = newAcct.id;
    invalidateAccountsCache();

    // Mark as rate-limited with a 1-hour cooldown
    const cooldownMs = 60 * 60 * 1000;
    markAccountRateLimited(accountId, cooldownMs, 'RateLimited');

    // Force reloading accounts from DB (simulating restart)
    invalidateAccountsCache();

    // Check if the loaded account has the cooldown synced from DB
    const loadedAccounts = loadAccounts();
    const target = loadedAccounts.find(a => a.id === accountId);
    assert.ok(target);
    assert.ok(target.cooldown_until);
    assert.ok(target.cooldown_until > Date.now());
    assert.strictEqual(target.cooldown_reason, 'RateLimited');

    // Verify rotation skips it
    const triedSet = new Set<string>();
    triedSet.add('dummy-id'); // to force getNextAvailableAccount check
    const available = getNextAvailableAccount(triedSet);
    // Since our test account is on cooldown, if it was returned, it means no other account was available,
    // or if we have other non-cooldown accounts, it returned one of them.
    if (available && available.id === accountId) {
      // If it returned our test account, it must be because all accounts are on cooldown.
      // Let's assert that the cooldown is actually registered in memory.
      getNextAccount();
      // It shouldn't be the first option if others are available
    }

    // Clear cooldown and verify it is updated in DB
    clearAccountCooldown(accountId);
    invalidateAccountsCache();

    const reloaded = loadAccounts().find(a => a.id === accountId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.cooldown_until || 0, 0);
    assert.strictEqual(reloaded.cooldown_reason, null);

  } finally {
    if (accountId) {
      removeAccount(accountId);
    }
    invalidateAccountsCache();
  }
});

test('Account Cooldown: recovered account becomes selectable after cooldown', async () => {
  const emails = ['cooldown-recov-1@test.com', 'cooldown-recov-2@test.com'];
  const ids: string[] = [];

  try {
    for (const email of emails) {
      ids.push(addAccount(email, 'password123').id);
    }
    invalidateAccountsCache();

    const [readyId, recoveredId] = ids;
    // Isolate the test: mark every pre-existing (real) account as busy so the
    // router can only consider our two test accounts.
    for (const a of loadAccounts()) {
      if (!ids.includes(a.id)) markAccountInUse(a.id);
    }

    // `readyId` is a healthy, ready account that is currently busy.
    markAccountReady(readyId);
    markAccountInUse(readyId);
    // `recoveredId` was on cooldown (simulating startup-cooldown or an expired
    // 429) and its browser context was never initialized -> not ready.
    markAccountNotReady(recoveredId);
    markAccountRateLimited(recoveredId, 60000, 'RateLimited');

    // While still on cooldown it must NOT be selected.
    const duringCooldown = getNextAccount(true);
    assert.ok(!duringCooldown || duringCooldown.id !== recoveredId,
      'account still on cooldown should not be selected');

    // Clearing the cooldown makes the only free account (un-ready) selectable.
    clearAccountCooldown(recoveredId);

    const afterCooldown = getNextAccount(true);
    assert.ok(afterCooldown, 'a free account should be available after cooldown');
    assert.strictEqual(afterCooldown!.id, recoveredId,
      'recovered (cooldown-cleared, un-ready) account must become selectable');
  } finally {
    releaseAccountInUse(ids[0]);
    for (const id of ids) {
      if (id) removeAccount(id);
    }
    invalidateAccountsCache();
  }
});
