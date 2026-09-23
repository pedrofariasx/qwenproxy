import { test } from 'node:test';
import assert from 'node:assert';
import {
  recordAccountBlock,
  noteAccountRecovery,
  requiresCrossAccountBootstrap,
  getIsolationStatus,
  setFingerprintRotationListener,
  clearAccountIsolation,
} from '../core/account-isolation.js';
import {
  getFingerprintProfile,
  rotateFingerprintSeed,
  getFingerprintSaltValue,
} from '../services/fingerprint.js';
import { getAccountCooldownInfo } from '../core/account-manager.js';
import { getBaseAccountId, makeAccountLaneId } from '../core/account-lanes.js';

test('fingerprint: rotating one account never changes another account fingerprint', () => {
  const a = 'iso-fp-a';
  const b = 'iso-fp-b';

  const beforeA = getFingerprintProfile(a);
  const beforeB = getFingerprintProfile(b);
  const saltA0 = getFingerprintSaltValue(a);
  const saltB0 = getFingerprintSaltValue(b);

  rotateFingerprintSeed(a);

  const afterA = getFingerprintProfile(a);
  const afterB = getFingerprintProfile(b);

  // A changed, B is byte-for-byte identical.
  assert.notStrictEqual(afterA.userAgent, beforeA.userAgent, 'A fingerprint must change after rotation');
  assert.notStrictEqual(afterA.webglRenderer, beforeA.webglRenderer, 'A GPU identity must change after rotation');
  assert.strictEqual(afterB.userAgent, beforeB.userAgent, 'B fingerprint must be untouched');
  assert.strictEqual(afterB.webglRenderer, beforeB.webglRenderer, 'B GPU identity must be untouched');
  // Relative check (salt is persisted across runs): A bumps by exactly 1, B unchanged.
  assert.strictEqual(getFingerprintSaltValue(a), saltA0 + 1, 'A salt bumps by 1');
  assert.strictEqual(getFingerprintSaltValue(b), saltB0, 'B salt stays 0');
});

test('isolation: blocking account A never spills cooldown to account B (blast radius)', () => {
  const a = 'iso-blast-a';
  const b = 'iso-blast-b';

  clearAccountIsolation(a);
  clearAccountIsolation(b);

  const saltA0 = getFingerprintSaltValue(a);
  const saltB0 = getFingerprintSaltValue(b);

  const res = recordAccountBlock(a, 'rate-limited', 'test 429');

  assert.ok(res.quarantined, 'A is quarantined');
  assert.notStrictEqual(getAccountCooldownInfo(a), null, 'A is on cooldown');
  assert.strictEqual(getAccountCooldownInfo(b), null, 'B must NOT be on cooldown');
  // A soft (rate-limit) block must NOT rotate fingerprints for either account.
  assert.strictEqual(getFingerprintSaltValue(a), saltA0, 'soft block does not rotate A fingerprint');
  assert.strictEqual(getFingerprintSaltValue(b), saltB0, 'soft block does not rotate B fingerprint');

  clearAccountIsolation(a);
  clearAccountIsolation(b);
});

test('isolation: blocks escalate the cooldown window on repeat for the same account only', () => {
  const a = 'iso-esc-a';
  clearAccountIsolation(a);

  const first = recordAccountBlock(a, 'rate-limited', 'first');
  const second = recordAccountBlock(a, 'rate-limited', 'second');

  assert.ok(second.escalated, 'second block should be flagged as escalated');
  assert.ok(second.cooldownMs > first.cooldownMs, 'escalated cooldown must be longer');

  clearAccountIsolation(a);
});

test('contingency: hard block (captcha) rotates fingerprint and fires the reset hook for that account only', () => {
  const a = 'iso-hard-a';
  const b = 'iso-hard-b';
  clearAccountIsolation(a);
  clearAccountIsolation(b);

  let listenerBase: string | null = null;
  setFingerprintRotationListener((base) => { listenerBase = base; });

  const saltA0 = getFingerprintSaltValue(a);
  const saltB0 = getFingerprintSaltValue(b);

  const res = recordAccountBlock(a, 'captcha', 'TMD challenge');

  assert.ok(res.fingerprintRotated, 'hard block rotates the fingerprint');
  assert.strictEqual(res.baseAccountId, a);
  assert.strictEqual(listenerBase, a, 'reset hook fired only for the blocked account');
  assert.strictEqual(getFingerprintSaltValue(a), saltA0 + 1, 'A fingerprint rotated by exactly 1');
  assert.strictEqual(getFingerprintSaltValue(b), saltB0, 'B fingerprint NOT rotated');
  assert.strictEqual(getAccountCooldownInfo(b), null, 'B still clear');

  setFingerprintRotationListener(() => {}); // reset so it cannot affect later tests
  clearAccountIsolation(a);
  clearAccountIsolation(b);
});

test('isolation: recovery resets the consecutive-block counter (no perpetual escalation)', () => {
  const a = 'iso-rec-a';
  clearAccountIsolation(a);

  recordAccountBlock(a, 'server-error', 'once');
  recordAccountBlock(a, 'server-error', 'twice');
  noteAccountRecovery(a);
  const third = recordAccountBlock(a, 'server-error', 'thrice');

  assert.strictEqual(third.escalated, false, 'cooldown should not escalate after a recovery reset');
  assert.strictEqual(third.cooldownMs, 3 * 60 * 1000, 'back to base window after recovery');

  clearAccountIsolation(a);
});

test('session guard: requiresCrossAccountBootstrap only triggers across different accounts', () => {
  const base = 'iso-sess-base';
  const lane1 = makeAccountLaneId(base, 1);
  const lane2 = makeAccountLaneId(base, 2);
  const other = 'iso-sess-other';

  // No session → never bootstrap.
  assert.strictEqual(requiresCrossAccountBootstrap(lane1, null), false);
  assert.strictEqual(requiresCrossAccountBootstrap(lane1, undefined), false);

  // Routed lane of the SAME base account as the session → reuse (no bootstrap).
  assert.strictEqual(requiresCrossAccountBootstrap(lane1, lane2), false);
  assert.strictEqual(requiresCrossAccountBootstrap(lane2, base), false);

  // Routed account differs from the session's account → force fresh bootstrap.
  assert.strictEqual(requiresCrossAccountBootstrap(other, lane1), true);
  assert.strictEqual(requiresCrossAccountBootstrap(lane1, other), true);

  // Missing routed account falls back to the session's own base → no bootstrap.
  assert.strictEqual(requiresCrossAccountBootstrap(null, lane1), false);
  assert.strictEqual(getBaseAccountId(lane1), base);
});

test('observability: getIsolationStatus reports per-account state without cross-talk', () => {
  const a = 'iso-status-a';
  const b = 'iso-status-b';
  clearAccountIsolation(a);
  clearAccountIsolation(b);

  recordAccountBlock(a, 'flagged', 'manual flag');

  const status = getIsolationStatus();
  assert.ok(status[a], 'status present for blocked account');
  assert.strictEqual(status[a].fingerprintRotations, 1);
  assert.strictEqual(status[a].quarantined, true);
  assert.strictEqual(status[b], undefined, 'untouched account has no isolation entry');

  clearAccountIsolation(a);
  clearAccountIsolation(b);
});

test('fingerprint: each lane of the same account gets a distinct fingerprint', () => {
  const base = 'iso-lane-fp';
  const lane1 = makeAccountLaneId(base, 1);
  const lane2 = makeAccountLaneId(base, 2);
  const lane3 = makeAccountLaneId(base, 3);

  const fp1 = getFingerprintProfile(lane1);
  const fp2 = getFingerprintProfile(lane2);
  const fp3 = getFingerprintProfile(lane3);
  const fpBase = getFingerprintProfile(base);

  assert.notStrictEqual(fp1.userAgent, fp2.userAgent, 'lane 1 and lane 2 must have different user agents');
  assert.notStrictEqual(fp2.userAgent, fp3.userAgent, 'lane 2 and lane 3 must have different user agents');
  assert.notStrictEqual(fp1.userAgent, fp3.userAgent, 'lane 1 and lane 3 must have different user agents');
  assert.notStrictEqual(fp1.userAgent, fpBase.userAgent, 'lane 1 must differ from base account');

  assert.notStrictEqual(fp1.prngSeed, fp2.prngSeed, 'lane 1 and lane 2 must have different PRNG seeds');
  assert.notStrictEqual(fp2.prngSeed, fp3.prngSeed, 'lane 2 and lane 3 must have different PRNG seeds');

  assert.strictEqual(getFingerprintSaltValue(lane1), getFingerprintSaltValue(lane2), 'lanes share the same salt (rotation is per-base-account)');
});

test('fingerprint: rotating base account rotates all lane fingerprints', () => {
  const base = 'iso-lane-rotate';
  const lane1 = makeAccountLaneId(base, 1);
  const lane2 = makeAccountLaneId(base, 2);

  const before1 = getFingerprintProfile(lane1);
  const before2 = getFingerprintProfile(lane2);

  rotateFingerprintSeed(base);

  const after1 = getFingerprintProfile(lane1);
  const after2 = getFingerprintProfile(lane2);

  assert.notStrictEqual(after1.userAgent, before1.userAgent, 'lane 1 fingerprint must change after base rotation');
  assert.notStrictEqual(after2.userAgent, before2.userAgent, 'lane 2 fingerprint must change after base rotation');
  assert.notStrictEqual(after1.userAgent, after2.userAgent, 'lanes remain distinct after rotation');
});
