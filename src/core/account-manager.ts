import { QwenAccount, loadAccounts } from './accounts.ts'
import { getDatabase } from './database.ts'
import { terminal } from './terminal.ts'

let currentIndex = 0

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000 // 3 minutes

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  const until = Date.now() + (cooldownMs ?? DEFAULT_COOLDOWN_MS)
  cooldowns.set(accountId, {
    until,
    reason: reason ?? 'RateLimited',
  })
  persistRuntime(accountId, {
    cooldownUntil: until,
    cooldownReason: reason ?? 'RateLimited',
    lastError: reason ?? 'RateLimited',
  })
  terminal.warn('Account', `Cooldown applied to ${accountId}`, [
    `reason: ${reason ?? 'RateLimited'}`,
    `until: ${new Date(until).toLocaleString()}`,
  ])
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId)
  persistRuntime(accountId, {
    cooldownUntil: null,
    cooldownReason: null,
  })
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId)
  const persisted = entry ?? getPersistedCooldown(accountId)
  if (!persisted) return null

  const remaining = persisted.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    clearAccountCooldown(accountId)
    return null
  }
  cooldowns.set(accountId, persisted)
  return { onCooldown: true, remainingMs: remaining, reason: persisted.reason }
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null
}

export function getNextAccount(): QwenAccount | null {
  const accounts = loadAccounts()
  if (accounts.length === 0) {
    return null
  }

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[currentIndex % accounts.length]
    currentIndex = (currentIndex + 1) % accounts.length
    if (!isAccountOnCooldown(account.id)) {
      recordAccountDispatch(account.id)
      return account
    }
  }

  // All accounts on cooldown — return the one with the shortest remaining cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getNextAvailableAccount(skipAccountId?: string): QwenAccount | null {
  const accounts = loadAccounts()
  if (accounts.length === 0) return null

  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length
    const account = accounts[idx]
    if (skipAccountId && account.id === skipAccountId) continue
    if (!isAccountOnCooldown(account.id)) {
      currentIndex = (idx + 1) % accounts.length
      recordAccountDispatch(account.id)
      return account
    }
  }

  // All remaining accounts on cooldown — return the one with shortest cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    if (skipAccountId && account.id === skipAccountId) continue
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getAccountCount(): number {
  return loadAccounts().length
}

export function getCooldownStatus(): Record<string, { remainingMs: number; reason: string }> {
  const result: Record<string, { remainingMs: number; reason: string }> = {}
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now()
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason }
    }
  }
  return result
}

export function resetAccountManagerForTests(): void {
  currentIndex = 0
  cooldowns.clear()
}

function recordAccountDispatch(accountId: string): void {
  persistRuntime(accountId, { incrementRequestCount: true })
}

function getPersistedCooldown(accountId: string): CooldownEntry | null {
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT cooldown_until AS until, cooldown_reason AS reason
      FROM account_runtime
      WHERE account_id = ?
    `).get(accountId) as { until: number | null; reason: string | null } | undefined
    if (!row?.until) return null
    return {
      until: row.until,
      reason: row.reason || 'Cooldown',
    }
  } catch {
    return null
  }
}

function persistRuntime(accountId: string, patch: {
  cooldownUntil?: number | null
  cooldownReason?: string | null
  lastError?: string | null
  incrementRequestCount?: boolean
}): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO account_runtime (
        account_id,
        last_used_at,
        cooldown_until,
        cooldown_reason,
        last_error,
        request_count,
        updated_at
      )
      VALUES (
        @accountId,
        datetime('now'),
        @cooldownUntil,
        @cooldownReason,
        @lastError,
        @requestCount,
        datetime('now')
      )
      ON CONFLICT(account_id) DO UPDATE SET
        last_used_at = CASE WHEN @incrementRequestCount = 1 THEN datetime('now') ELSE account_runtime.last_used_at END,
        cooldown_until = CASE WHEN @touchCooldown = 1 THEN @cooldownUntil ELSE account_runtime.cooldown_until END,
        cooldown_reason = CASE WHEN @touchCooldown = 1 THEN @cooldownReason ELSE account_runtime.cooldown_reason END,
        last_error = COALESCE(@lastError, account_runtime.last_error),
        request_count = account_runtime.request_count + @requestCount,
        updated_at = datetime('now')
    `).run({
      accountId,
      cooldownUntil: patch.cooldownUntil ?? null,
      cooldownReason: patch.cooldownReason ?? null,
      lastError: patch.lastError ?? null,
      requestCount: patch.incrementRequestCount ? 1 : 0,
      incrementRequestCount: patch.incrementRequestCount ? 1 : 0,
      touchCooldown: Object.prototype.hasOwnProperty.call(patch, 'cooldownUntil') ? 1 : 0,
    })
  } catch {
    // Runtime bookkeeping must never break request routing.
  }
}
