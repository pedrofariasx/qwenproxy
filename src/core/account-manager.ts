import { QwenAccount, loadAccounts } from './accounts.ts'
import { Logger } from './logger.js'

const logger = new Logger('info', 'AccountManager')

let currentIndex = 0

export function resetAccountRotationForTests(): void {
  currentIndex = 0
}

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000 // 3 minutes

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  cooldowns.set(accountId, {
    until: Date.now() + (cooldownMs ?? DEFAULT_COOLDOWN_MS),
    reason: reason ?? 'RateLimited',
  })
  logger.info(`Account ${accountId} marked as rate-limited. Cooldown until ${new Date(Date.now() + (cooldownMs ?? DEFAULT_COOLDOWN_MS)).toISOString()}`)
}

export function clearAccountCooldown(accountId: string): void {
  cooldowns.delete(accountId)
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const entry = cooldowns.get(accountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    return null
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason }
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
