import { test } from 'node:test';
import assert from 'node:assert';
import { addAccount, loadAccounts, removeAccount } from '../core/accounts.ts';
import { getNextAccount, resetAccountRotationForTests } from '../core/account-manager.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const originalAccounts = loadAccounts();

  try {
    for (const account of originalAccounts) {
      removeAccount(account.id);
    }

    const mockAccounts = [
      addAccount('account1@test.com', 'password1', 'acc1'),
      addAccount('account2@test.com', 'password2', 'acc2'),
      addAccount('account3@test.com', 'password3', 'acc3'),
    ];

    resetAccountRotationForTests();

    const first = getNextAccount();
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    assert.strictEqual(first?.email, mockAccounts[0].email);
    assert.strictEqual(second?.email, mockAccounts[1].email);
    assert.strictEqual(third?.email, mockAccounts[2].email);
    assert.strictEqual(fourth?.email, mockAccounts[0].email);
  } finally {
    for (const account of loadAccounts()) {
      removeAccount(account.id);
    }

    for (const account of originalAccounts) {
      addAccount(account.email, account.password, account.id);
    }

    resetAccountRotationForTests();
  }
});
