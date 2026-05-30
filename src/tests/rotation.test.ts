import { test } from 'node:test';
import assert from 'node:assert';
import { getDatabase } from '../core/database.ts';
import { invalidateAccountsCache } from '../core/accounts.ts';
import { getNextAccount } from '../core/account-manager.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const originalEnv = process.env.QWEN_ACCOUNTS;
  delete process.env.QWEN_ACCOUNTS;

  const db = getDatabase();
  const existing = db.prepare('SELECT id, email, password FROM accounts').all();
  db.prepare('DELETE FROM accounts').run();
  invalidateAccountsCache();

  try {
    const insert = db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)');
    insert.run('acc1', 'account1@test.com', 'password1');
    insert.run('acc2', 'account2@test.com', 'password2');
    insert.run('acc3', 'account3@test.com', 'password3');
    invalidateAccountsCache();

    const first = getNextAccount();
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    assert.strictEqual(first!.email, 'account1@test.com');
    assert.strictEqual(second!.email, 'account2@test.com');
    assert.strictEqual(third!.email, 'account3@test.com');
    assert.strictEqual(fourth!.email, 'account1@test.com');

  } finally {
    db.prepare('DELETE FROM accounts').run();
    const insert = db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)');
    for (const row of existing as any[]) {
      insert.run(row.id, row.email, row.password);
    }
    invalidateAccountsCache();
    if (originalEnv !== undefined) {
      process.env.QWEN_ACCOUNTS = originalEnv;
    }
  }
});
