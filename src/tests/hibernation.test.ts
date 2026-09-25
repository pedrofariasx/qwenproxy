import test from 'node:test';
import assert from 'node:assert';
import {
  touchAccountActivity,
  getAccountLastActivity,
  hibernateAccountContext,
  hibernateIdleAccountContexts,
} from '../services/browser-manager.js';

test('touchAccountActivity: updates and tracks timestamp for account', () => {
  const accountId = 'test-acct-activity';
  const before = Date.now();
  touchAccountActivity(accountId);
  const after = Date.now();

  const recorded = getAccountLastActivity(accountId);
  assert.ok(recorded !== undefined);
  assert.ok(recorded >= before && recorded <= after);
});

test('hibernateAccountContext: returns false gracefully for non-existent context', async () => {
  const result = await hibernateAccountContext('non-existent-account-id');
  assert.strictEqual(result, false);
});

test('hibernateIdleAccountContexts: handles empty or active accounts safely', async () => {
  const hibernatedCount = await hibernateIdleAccountContexts(60000);
  assert.strictEqual(typeof hibernatedCount, 'number');
  assert.strictEqual(hibernatedCount, 0);
});
