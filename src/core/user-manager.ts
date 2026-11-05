/**
 * Per-user identity, rate limiting and concurrency caps for multi-user setups.
 *
 * Identities are resolved from:
 *  1. The proxy-wide `API_KEY` (the "global" user),
 *  2. Per-user rows in the `users` SQLite table,
 *  3. `USER_API_KEYS` env (comma-separated `key[:label]` entries) seeded into
 *     the table on first use.
 */

import crypto from 'crypto';
import { config } from './config.js';
import { getUserByApiKey, upsertUser, listUsers } from './database.js';

export interface UserIdentity {
  id: string;
  email: string | null;
  rateLimitRpm: number;
  maxConcurrency: number;
  isGlobal: boolean;
}

const rateWindows = new Map<string, number[]>();
const activeStreams = new Map<string, number>();

function defaultIdentity(id: string, email: string | null, isGlobal: boolean): UserIdentity {
  return {
    id,
    email,
    rateLimitRpm: config.users.defaultRateLimitRpm,
    maxConcurrency: config.users.defaultMaxConcurrency,
    isGlobal,
  };
}

export function parseApiKeyConfig(value: string): Array<{
  label: string
  key: string
  rateLimitRpm: number
  maxConcurrency: number
}> {
  const raw = value.trim()
  const entries = raw.includes(';')
    ? raw.split(';')
    : /^[^:]+:[^,]+,\d+,\d+$/.test(raw)
      ? [raw]
      : raw.split(',').filter(entry => entry.includes(':'))
  return entries.flatMap(entry => {
    const [first, ...parts] = entry.trim().split(':')
    if (!first) return []
    if (parts.length === 1 && parts[0].includes(',')) {
      const [key, rpm, concurrency] = parts[0].split(',')
      return key ? [{
        label: first,
        key: key.trim(),
        rateLimitRpm: Number(rpm) || config.users.defaultRateLimitRpm,
        maxConcurrency: Number(concurrency) || config.users.defaultMaxConcurrency,
      }] : []
    }
    return [{
      label: parts.join(':') || `user-${first.slice(0, 6)}`,
      key: first,
      rateLimitRpm: config.users.defaultRateLimitRpm,
      maxConcurrency: config.users.defaultMaxConcurrency,
    }]
  })
}

function seedEnvApiKeys(): void {
  if (!config.users.apiKeys) return;
  const existing = new Set(listUsers().map(u => u.id));
  for (const { label, key, rateLimitRpm, maxConcurrency } of parseApiKeyConfig(config.users.apiKeys)) {
    if (!existing.has(label)) {
      try {
        upsertUser({ id: label, email: label, apiKey: key, rateLimitRpm, maxConcurrency });
      } catch { /* ignore duplicate key */ }
    }
  }
}

let seeded = false;

/**
 * Resolves the caller identity from an `Authorization` header value, or null
 * when the token is not recognized (middleware should reject).
 */
export function resolveUserFromAuthHeader(authHeader?: string | null): UserIdentity | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  // 1. Proxy-wide API key → global user (constant-time comparison).
  const globalKey = (process.env.API_KEY || config.apiKey || '').trim();
  if (globalKey) {
    const a = Buffer.from(token);
    const b = Buffer.from(globalKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return defaultIdentity('global', null, true);
    }
  }

  // 2/3. Per-user keys (DB + env seeds).
  if (!seeded) {
    seeded = true;
    try { seedEnvApiKeys(); } catch { /* ignore */ }
  }
  try {
    const user = getUserByApiKey(token);
    if (user) {
      return {
        id: user.id,
        email: user.email,
        rateLimitRpm: user.rate_limit_rpm > 0 ? user.rate_limit_rpm : config.users.defaultRateLimitRpm,
        maxConcurrency: user.max_concurrency > 0 ? user.max_concurrency : config.users.defaultMaxConcurrency,
        isGlobal: false,
      };
    }
  } catch { /* db not ready */ }
  return null;
}

/** Sliding-window RPM check. Returns true when the request is allowed. */
export function checkUserRateLimit(userId: string, limitRpm: number): boolean {
  if (limitRpm <= 0) return true;
  const now = Date.now();
  const windowMs = 60_000;
  const cutoff = now - windowMs;
  const timestamps = (rateWindows.get(userId) || []).filter(t => t > cutoff);
  if (timestamps.length >= limitRpm) {
    rateWindows.set(userId, timestamps);
    return false;
  }
  timestamps.push(now);
  rateWindows.set(userId, timestamps);
  return true;
}

/** Acquires a concurrency slot for the user. Returns false when at the cap. */
export function tryAcquireUserSlot(userId: string, maxConcurrency: number): boolean {
  if (maxConcurrency <= 0) return true;
  const current = activeStreams.get(userId) || 0;
  if (current >= maxConcurrency) return false;
  activeStreams.set(userId, current + 1);
  return true;
}

export function releaseUserSlot(userId: string): void {
  const current = activeStreams.get(userId) || 0;
  if (current <= 1) activeStreams.delete(userId);
  else activeStreams.set(userId, current - 1);
}

export function getUserActiveStreams(userId: string): number {
  return activeStreams.get(userId) || 0;
}

export function getRateLimitInfo(userId: string, userLimit?: number): { used: number; limit: number; windowMs: number } {
  const now = Date.now();
  const cutoff = now - 60_000;
  const timestamps = (rateWindows.get(userId) || []).filter(t => t > cutoff);
  const limit = userLimit && userLimit > 0 ? userLimit : config.users.defaultRateLimitRpm;
  return { used: timestamps.length, limit, windowMs: 60_000 };
}