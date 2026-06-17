import type { QwenAccount} from './accounts.js';
import { loadAccounts, updateAccountCooldown, invalidateAccountsCache as invalidateAccountsCacheSource } from './accounts.js'

let currentIndex = 0

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000

function getAccountsWithCooldownSync(): QwenAccount[] {
  const accounts = loadAccounts()
  const now = Date.now()

  for (const account of accounts) {
    if (account.cooldown_until && account.cooldown_until > now) {
      cooldowns.set(account.id, {
        until: account.cooldown_until,
        reason: account.cooldown_reason || 'RateLimited',
      })
    } else {
      cooldowns.delete(account.id)
    }
  }

  return accounts
}

export function invalidateAccountsCache(): void {
  invalidateAccountsCacheSource()
}

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  const duration = cooldownMs ?? DEFAULT_COOLDOWN_MS
  const until = Date.now() + duration
  const cooldownReason = reason ?? 'RateLimited'

  cooldowns.set(accountId, {
    until,
    reason: cooldownReason,
  })

  if (accountId !== 'global') {
    try {
      updateAccountCooldown(accountId, until, cooldownReason)
    } catch (err) {
      console.error(`[AccountManager] Failed to save cooldown to DB for account ${accountId}:`, (err as Error).message)
    }
  }

  console.log(`[AccountManager] Account ${accountId} marked as rate-limited. Cooldown until ${new Date(until).toISOString()}`)
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId)
  if (accountId !== 'global') {
    try {
      updateAccountCooldown(accountId, 0, null)
    } catch (err) {
      console.error(`[AccountManager] Failed to clear cooldown in DB for account ${accountId}:`, (err as Error).message)
    }
  }
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    if (accountId !== 'global') {
      try {
        updateAccountCooldown(accountId, 0, null)
      } catch (err) {
        console.error(`[AccountManager] Failed to clear expired cooldown in DB:`, (err as Error).message)
      }
    }
    return null
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason }
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null
}

export function getNextAccount(forceReset?: boolean): QwenAccount | null {
  const accounts = getAccountsWithCooldownSync()
  if (accounts.length === 0) {
    return null
  }

  if (forceReset) {
    currentIndex = 0
  }

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[currentIndex % accounts.length]
    currentIndex = (currentIndex + 1) % accounts.length
    if (!isAccountOnCooldown(account.id)) {
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

export function getNextAvailableAccount(triedAccountIds?: Set<string> | string): QwenAccount | null {
  const accounts = getAccountsWithCooldownSync()
  if (accounts.length === 0) return null

  let triedSet: Set<string>
  if (triedAccountIds instanceof Set) {
    triedSet = triedAccountIds
  } else {
    triedSet = new Set(triedAccountIds ? [triedAccountIds] : [])
  }

  // 1. Try to find an untried account that is NOT on cooldown
  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length
    const account = accounts[idx]
    if (triedSet.has(account.id)) continue
    if (!isAccountOnCooldown(account.id)) {
      currentIndex = (idx + 1) % accounts.length
      return account
    }
  }

  // 2. If all untried accounts are on cooldown, return the untried one with the shortest remaining cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    if (triedSet.has(account.id)) continue
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getAccountCount(): number {
  return getAccountsWithCooldownSync().length
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
