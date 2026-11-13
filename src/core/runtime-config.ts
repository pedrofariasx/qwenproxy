/**
 * Runtime-adjustable settings: a thin live-override layer on top of the env
 * config so the admin dashboard can change a curated set of keys WITHOUT
 * restarting the server. Values are also persisted to `.env` so they survive a
 * restart, but the in-memory override applies immediately.
 */

import { config } from './config.js'

/** Keys that can be changed at runtime without a server restart. */
export const LIVE_KEYS = new Set([
  'WARM_POOL_SIZE',
  'WARM_POOL_LOW_WATER',
  'WARM_POOL_TTL_MS',
  'WARM_POOL_REFILL_BACKOFF_MS',
  'ACCOUNT_MAX_CONCURRENT_STREAMS',
  'ACCOUNT_STREAM_SLOT_WAIT_MS',
  'QWEN_DIRECT_FETCH',
  'DIRECT_FETCH_BLOCK_MS',
  'DIRECT_FETCH_FAILURE_THRESHOLD',
  'HEADERS_TTL_MS',
  'BACKGROUND_HEADER_REFRESH',
  'QWEN_GUEST_MODE_ONLY',
  'AUTH_SESSION_ENABLED',
  'TOKEN_REFRESH_SKEW_MS',
])

const overrides = new Map<string, string>()

/** Applies a live override immediately. `null` clears the override. */
export function applyRuntimeSetting(key: string, value: string | number | null): void {
  if (!LIVE_KEYS.has(key)) return
  if (value === null || String(value).trim() === '') {
    overrides.delete(key)
  } else {
    overrides.set(key, String(value).trim())
  }
}

export function getRuntimeSetting(key: string): string | undefined {
  return overrides.get(key)
}

export function getRuntimeInt(key: string, fallback: number): number {
  const raw = overrides.get(key)
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

export function getRuntimeBool(key: string, fallback: boolean): boolean {
  const raw = overrides.get(key)
  if (raw === undefined) return fallback
  return raw !== 'false'
}

/** Current live overrides (empty when nothing was changed at runtime). */
export function getLiveSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of overrides) {
    if (LIVE_KEYS.has(key)) out[key] = value
  }
  return out
}

// Re-exported so callers can reference config-derived defaults without a second
// import of the config module.
export { config }
