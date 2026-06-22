import type { QwenAccount} from './accounts.js';
import { loadAccounts, updateAccountCooldown, invalidateAccountsCache as invalidateAccountsCacheSource } from './accounts.js'
import { config } from './config.js'
import { getBaseAccountId, makeAccountLaneId } from './account-lanes.js'

let currentIndex = 0
const inUseAccounts = new Set<string>()

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000

function expandSingleAccountLanes(accounts: QwenAccount[]): QwenAccount[] {
  if (!config.accounts.singleAccountMode) return accounts

  const selected = accounts.find(account => {
    if (config.accounts.singleAccountId) return account.id === config.accounts.singleAccountId
    if (config.accounts.singleAccountEmail) return account.email === config.accounts.singleAccountEmail
    return !account.cooldown_until || account.cooldown_until <= Date.now()
  }) || accounts[0]

  if (!selected) return []

  return Array.from({ length: config.accounts.lanes }, (_, index) => ({
    ...selected,
    id: makeAccountLaneId(selected.id, index + 1),
    email: `${selected.email}#lane-${index + 1}`,
  }))
}

function getAccountsWithCooldownSync(): QwenAccount[] {
  const accounts = expandSingleAccountLanes(loadAccounts())
  const now = Date.now()

  for (const account of accounts) {
    const baseAccountId = getBaseAccountId(account.id)
    const cooldownUntil = account.cooldown_until || cooldowns.get(baseAccountId)?.until || 0
    const cooldownReason = account.cooldown_reason || cooldowns.get(baseAccountId)?.reason || 'RateLimited'

    if (cooldownUntil && cooldownUntil > now) {
      cooldowns.set(account.id, {
        until: cooldownUntil,
        reason: cooldownReason,
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
  const baseAccountId = getBaseAccountId(accountId)
  const duration = cooldownMs ?? DEFAULT_COOLDOWN_MS
  const until = Date.now() + duration
  const cooldownReason = reason ?? 'RateLimited'

  cooldowns.set(accountId, {
    until,
    reason: cooldownReason,
  })
  cooldowns.set(baseAccountId, {
    until,
    reason: cooldownReason,
  })

  if (baseAccountId !== 'global') {
    try {
      updateAccountCooldown(baseAccountId, until, cooldownReason)
    } catch (err) {
      console.error(`[AccountManager] Failed to save cooldown to DB for account ${baseAccountId}:`, (err as Error).message)
    }
  }

  console.log(`[AccountManager] Account ${accountId} marked as rate-limited. Cooldown until ${new Date(until).toISOString()}`)
}

export function clearAccountCooldown(accountId: string): void {
  const baseAccountId = getBaseAccountId(accountId)
  cooldowns.delete(accountId)
  cooldowns.delete(baseAccountId)
  if (baseAccountId !== 'global') {
    try {
      updateAccountCooldown(baseAccountId, 0, null)
    } catch (err) {
      console.error(`[AccountManager] Failed to clear cooldown in DB for account ${baseAccountId}:`, (err as Error).message)
    }
  }
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const baseAccountId = getBaseAccountId(accountId)
  const entry = cooldowns.get(accountId) || cooldowns.get(baseAccountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    cooldowns.delete(baseAccountId)
    if (baseAccountId !== 'global') {
      try {
        updateAccountCooldown(baseAccountId, 0, null)
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

function isAccountInUse(accountId: string): boolean {
  return inUseAccounts.has(accountId)
}

export function markAccountInUse(accountId: string): void {
  inUseAccounts.add(accountId)
}

export function releaseAccountInUse(accountId: string): void {
  inUseAccounts.delete(accountId)
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
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      return account
    }
  }

  if (config.accounts.singleAccountMode) {
    return null
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
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      currentIndex = (idx + 1) % accounts.length
      return account
    }
  }

  if (config.accounts.singleAccountMode) {
    return null
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

export function getActiveAccountCount(): number {
  return getAccountsWithCooldownSync().filter(account => !isAccountOnCooldown(account.id)).length
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

export function getInUseAccounts(): string[] {
  return Array.from(inUseAccounts)
}
