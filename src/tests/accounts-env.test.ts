import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

test('Accounts env import: syncs list and numbered credentials', async () => {
  process.env.BROWSER = 'chromium';

  const { getAccountCredentials, importAccountsFromEnv, loadAccounts, removeAccount } = await import('../core/accounts.ts');
  const { invalidateAccountsCache } = await import('../core/account-manager.ts');

  const suffix = crypto.randomUUID();
  const emailA = `env-a-${suffix}@test.local`;
  const emailB = `env-b-${suffix}@test.local`;
  const emailC = `env-c-${suffix}@test.local`;
  const createdIds: string[] = [];

  try {
    const summary = importAccountsFromEnv({
      QWEN_ACCOUNTS: `${emailA}:password:with:colon;${emailB}:password-b`,
      QWEN_EMAIL_1: emailC,
      QWEN_PASSWORD_1: 'password-c',
    });

    assert.strictEqual(summary.discovered, 3);
    assert.strictEqual(summary.inserted, 3);

    invalidateAccountsCache();
    const imported = loadAccounts().filter(account => [emailA, emailB, emailC].includes(account.email));
    assert.strictEqual(imported.length, 3);
    createdIds.push(...imported.map(account => account.id));

    const accountA = imported.find(account => account.email === emailA);
    assert.ok(accountA);
    assert.strictEqual(getAccountCredentials(accountA.id)?.password, 'password:with:colon');

    const updateSummary = importAccountsFromEnv({
      QWEN_ACCOUNTS: `${emailA}:updated-password`,
    });
    assert.strictEqual(updateSummary.discovered, 1);
    assert.strictEqual(updateSummary.updated, 1);

    invalidateAccountsCache();
    assert.strictEqual(getAccountCredentials(accountA.id)?.password, 'updated-password');
  } finally {
    for (const id of createdIds) {
      removeAccount(id);
    }
    invalidateAccountsCache();
  }
});
