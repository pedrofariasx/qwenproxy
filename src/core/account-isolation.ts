/**
 * Per-account isolation & contingency system.
 *
 * This module is the single authority for "what happens to an account when it
 * is rate-limited, flagged, hit with a captcha/TMD challenge, or otherwise
 * temporarily blocked". Its job is to make sure ONE account's bad state can
 * NEVER leak into another account's resources — and to provide an automatic
 * recovery (contingency) path.
 *
 * Isolation guarantees:
 *  - Every operation works strictly on `getBaseAccountId(accountId)`. It never
 *    iterates, reads, or mutates another account's state, so a block on account
 *    A can never flip a cooldown/ready/in-use bit for account B.
 *  - Browser context, headers, cookies, warm pool, session pins and the device
 *    fingerprint are all keyed per account (see browser-manager / session-manager
 *    / fingerprint), so this module only ever *signals* a reset, it does not
 *    share anything across accounts.
 *
 * Contingency behavior on a block:
 *  - The account is quarantined (cooldown) so no new traffic is routed to it.
 *  - Soft blocks (429 / 5xx) quarantine for a base window and ESCALATE the
 *    window on repeated blocks for the same account.
 *  - Hard blocks (captcha/TMD, flagged, cookie invalidated) additionally rotate
 *    the account's device fingerprint and reset its browser context, so recovery
 *    happens as a fresh device identity — this is what stops a flag from
 *    re-propagating onto the same fingerprint the moment the cooldown ends.
 */

import { getBaseAccountId } from './account-lanes.js';
import {
  markAccountRateLimited,
  clearAccountCooldown,
  getAccountCooldownInfo,
} from './account-manager.js';
import { rotateFingerprintSeed, getFingerprintSaltValue } from '../services/fingerprint.js';
import { metrics } from './metrics.js';

export type BlockType =
  | 'rate-limited'
  | 'captcha'
  | 'flagged'
  | 'cookie-invalid'
  | 'server-error'
  | 'membership-limit';

// Hard blocks indicate the account's device identity / session is compromised:
// quarantining alone is not enough — we must also rotate the fingerprint and
// reset the browser context so recovery isn't immediately re-flagged.
const HARD_BLOCKS = new Set<BlockType>(['captcha', 'flagged', 'cookie-invalid']);

const BASE_COOLDOWN_MS = 3 * 60 * 1000;
const HARD_BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const ESCALATION_FACTOR = 2;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_BLOCK_HISTORY = 50;

export interface BlockEvent {
  type: BlockType;
  at: number;
  detail?: string;
}

export interface AccountIsolationState {
  baseAccountId: string;
  blocks: BlockEvent[];
  fingerprintRotations: number;
  /** Bumped every time the identity is rotated — downstream can detect change. */
  resourceVersion: number;
  consecutiveBlocks: number;
  quarantinedAt: number | null;
  lastRecoveryAt: number | null;
}

const states = new Map<string, AccountIsolationState>();

type RotationListener = (baseAccountId: string) => void | Promise<void>;
let rotationListener: RotationListener | null = null;

/**
 * Registers the hook that physically resets an account's browser resources when
 * its fingerprint is rotated (e.g. close its Playwright context). Supplied by
 * browser-manager so this module stays decoupled from Playwright.
 */
export function setFingerprintRotationListener(fn: RotationListener): void {
  rotationListener = fn;
}

function getState(base: string): AccountIsolationState {
  let s = states.get(base);
  if (!s) {
    s = {
      baseAccountId: base,
      blocks: [],
      fingerprintRotations: 0,
      resourceVersion: 0,
      consecutiveBlocks: 0,
      quarantinedAt: null,
      lastRecoveryAt: null,
    };
    states.set(base, s);
  }
  return s;
}

function blockReason(type: BlockType): string {
  switch (type) {
    case 'rate-limited': return 'RateLimited';
    case 'captcha': return 'CaptchaBlocked';
    case 'flagged': return 'Flagged';
    case 'cookie-invalid': return 'CookieInvalid';
    default: return 'ServerError';
  }
}

export interface BlockResult {
  quarantined: boolean;
  cooldownMs: number;
  fingerprintRotated: boolean;
  baseAccountId: string;
  escalated: boolean;
}

/**
 * Records a block event for a single account and applies the contingency:
 * quarantine + escalation for soft blocks, plus fingerprint rotation + context
 * reset for hard blocks. This is strictly per-account — it never touches any
 * other account.
 */
export function recordAccountBlock(
  accountId: string,
  type: BlockType,
  detail?: string,
  opts?: { cooldownMs?: number },
): BlockResult {
  const base = getBaseAccountId(accountId) || accountId;
  const s = getState(base);

  s.blocks.push({ type, at: Date.now(), detail });
  if (s.blocks.length > MAX_BLOCK_HISTORY) {
    s.blocks.splice(0, s.blocks.length - MAX_BLOCK_HISTORY);
  }

  const hard = HARD_BLOCKS.has(type);
  s.consecutiveBlocks += 1;

  let cooldownMs = opts?.cooldownMs ?? (hard ? HARD_BLOCK_COOLDOWN_MS : BASE_COOLDOWN_MS);
  let escalated = false;
  // Repeated blocks for the same account escalate the quarantine window so a
  // flapping account backs off harder instead of hammering Qwen in a loop.
  if (s.consecutiveBlocks > 1) {
    const factor = Math.pow(ESCALATION_FACTOR, Math.min(s.consecutiveBlocks - 1, 4));
    cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.round(cooldownMs * factor));
    escalated = true;
  }

  // Quarantine ONLY this account (markAccountRateLimited also pins the base id).
  markAccountRateLimited(base, cooldownMs, blockReason(type));
  s.quarantinedAt = Date.now();

  let fingerprintRotated = false;
  if (hard) {
    rotateFingerprintSeed(base);
    s.fingerprintRotations += 1;
    s.resourceVersion += 1;
    fingerprintRotated = true;
    if (rotationListener) {
      try {
        rotationListener(base);
      } catch (err: any) {
        console.warn(`[Isolation] fingerprint rotation listener failed for ${base}:`, err?.message);
      }
    }
    console.warn(`[Isolation] Hard block (${type}) on account ${base}: rotating device fingerprint (v${s.resourceVersion}) and resetting browser context.`);
  }

  metrics.increment('isolation.blocks');

  return { quarantined: true, cooldownMs, fingerprintRotated, baseAccountId: base, escalated };
}

/** Clears the consecutive-block counter when an account successfully recovers. */
export function noteAccountRecovery(accountId: string): void {
  const base = getBaseAccountId(accountId) || accountId;
  const s = getState(base);
  s.consecutiveBlocks = 0;
  s.quarantinedAt = null;
  s.lastRecoveryAt = Date.now();
}

/** Hard-resets all isolation state for an account (e.g. admin "clear cooldown"). */
export function clearAccountIsolation(accountId: string): void {
  const base = getBaseAccountId(accountId) || accountId;
  states.delete(base);
  clearAccountCooldown(base);
}

/** Monotonic version of an account's device identity; changes on rotation. */
export function getResourceVersion(accountId: string): number {
  const base = getBaseAccountId(accountId) || accountId;
  return getState(base).resourceVersion;
}

export function getFingerprintSalt(accountId: string): number {
  return getFingerprintSaltValue(accountId);
}

/**
 * Decides whether a request pinned to `sessionAccountId` must be served by a
 * FRESH chat (forceBootstrap) rather than reusing the session's pinned chat.
 *
 * This is the session-state isolation guard: a session's pinned chat_id and
 * headers belong to the account that created it. If routing selected a
 * DIFFERENT account (e.g. the pinned account is on cooldown), we must NOT reuse
 * the cross-account chat — we bootstrap a new chat on the selected account and
 * re-pin the session to it. Returning `true` forces that bootstrap.
 */
export function requiresCrossAccountBootstrap(
  routedAccountId: string | null | undefined,
  sessionAccountId: string | null | undefined,
): boolean {
  if (!sessionAccountId) return false;
  const routed = routedAccountId ?? getBaseAccountId(sessionAccountId);
  return getBaseAccountId(routed) !== getBaseAccountId(sessionAccountId);
}

export interface AccountIsolationStatus {
  blocks: number;
  consecutiveBlocks: number;
  fingerprintRotations: number;
  resourceVersion: number;
  quarantined: boolean;
  cooldownRemainingMs: number;
  lastReason: string | null;
}

/**
 * Observability snapshot of every account's isolation state. Keyed by base
 * account id. Safe to call from the admin dashboard.
 */
export function getIsolationStatus(): Record<string, AccountIsolationStatus> {
  const out: Record<string, AccountIsolationStatus> = {};
  for (const [base, s] of states) {
    const cd = getAccountCooldownInfo(base);
    out[base] = {
      blocks: s.blocks.length,
      consecutiveBlocks: s.consecutiveBlocks,
      fingerprintRotations: s.fingerprintRotations,
      resourceVersion: s.resourceVersion,
      quarantined: cd !== null,
      cooldownRemainingMs: cd?.remainingMs ?? 0,
      lastReason: cd?.reason ?? null,
    };
  }
  return out;
}
