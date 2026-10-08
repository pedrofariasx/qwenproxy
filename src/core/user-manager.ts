import crypto from 'crypto';
import { config } from './config.js';
import { getUserByApiKey, hasUsers } from './database.js';

export interface UserIdentity {
  id: string;
  email: string | null;
  rateLimitRpm: number;
  maxConcurrency: number;
  isGlobal: boolean;
  source?: 'environment';
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

function envApiKeys(): Array<{ key: string; label: string }> {
  return config.users.apiKeys.split(',').flatMap(entry => {
    const [key, ...labelParts] = entry.trim().split(':');
    if (!key) return [];
    const label = labelParts.join(':') || `env-${crypto.createHash('sha256').update(key).digest('hex')}`;
    return [{ key, label }];
  });
}

export function hasConfiguredApiKeys(): boolean {
  return Boolean((process.env.API_KEY || config.apiKey || '').trim()) || envApiKeys().length > 0 || hasUsers();
}

export function getUserPrincipal(user?: Pick<UserIdentity, 'id' | 'isGlobal' | 'source'>): string {
  return JSON.stringify(user ? user.isGlobal ? ['global'] : [user.source === 'environment' ? 'environment' : 'user', user.id] : ['anonymous']);
}

/**
 * Resolves the caller identity from an `Authorization` header value, or null
 * when the token is not recognized (middleware should reject).
 */
export function resolveUserFromAuthHeader(authHeader?: string | null): UserIdentity | null {
  const match = authHeader?.match(/^Bearer[ \t]+([^\s]+)[ \t]*$/i);
  if (!match) return null;
  const token = match[1];

  // 1. Proxy-wide API key → global user (constant-time comparison).
  const globalKey = (process.env.API_KEY || config.apiKey || '').trim();
  if (globalKey) {
    const a = Buffer.from(token);
    const b = Buffer.from(globalKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return defaultIdentity('global', null, true);
    }
  }

  try {
    const configured = envApiKeys().find(entry => entry.key === token);
    if (configured) return { ...defaultIdentity(configured.label, configured.label, false), source: 'environment' };
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

export function getTotalUserActiveStreams(): number {
  return [...activeStreams.values()].reduce((total, value) => total + value, 0);
}

export function getRateLimitInfo(userId: string, userLimit?: number): { used: number; limit: number; windowMs: number } {
  const now = Date.now();
  const cutoff = now - 60_000;
  const timestamps = (rateWindows.get(userId) || []).filter(t => t > cutoff);
  const limit = userLimit && userLimit > 0 ? userLimit : config.users.defaultRateLimitRpm;
  return { used: timestamps.length, limit, windowMs: 60_000 };
}
