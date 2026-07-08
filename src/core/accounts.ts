import crypto from 'crypto'
import { getDatabase } from './database.js'
import { config } from './config.js'
import { encrypt, decrypt } from './crypto-utils.js'

export interface QwenAccount {
  id: string
  email: string
  password: string
  cooldown_until?: number
  cooldown_reason?: string | null
}

export interface EnvAccountImportSummary {
  discovered: number
  inserted: number
  updated: number
  skipped: number
}

let accountsCache: QwenAccount[] | null = null
let accountsCacheTimestamp = 0
const ACCOUNTS_CACHE_TTL = config.cache.defaultTTL * 1000

function splitAccountEntry(entry: string): { email: string; password: string } | null {
  const separatorIndex = entry.indexOf(':')
  if (separatorIndex <= 0) return null

  const email = entry.slice(0, separatorIndex).trim()
  const password = entry.slice(separatorIndex + 1)
  if (!email || !password) return null

  return { email, password }
}

function parseQwenAccountsList(value?: string): Array<{ email: string; password: string }> {
  if (!value?.trim()) return []

  const delimiter = value.includes(';') ? ';' : ','
  return value
    .split(delimiter)
    .map(entry => splitAccountEntry(entry.trim()))
    .filter((entry): entry is { email: string; password: string } => entry !== null)
}

function collectEnvAccounts(env: NodeJS.ProcessEnv = process.env): Array<{ email: string; password: string }> {
  const collected: Array<{ email: string; password: string }> = []

  collected.push(...parseQwenAccountsList(env.QWEN_ACCOUNTS))

  if (env.QWEN_EMAIL && env.QWEN_PASSWORD) {
    collected.push({ email: env.QWEN_EMAIL, password: env.QWEN_PASSWORD })
  }

  const numberedIndexes = Object.keys(env)
    .map(key => /^QWEN_EMAIL_(\d+)$/.exec(key)?.[1])
    .filter((index): index is string => index !== undefined)
    .map(index => Number.parseInt(index, 10))
    .filter(index => Number.isFinite(index))
    .sort((a, b) => a - b)

  for (const index of numberedIndexes) {
    const email = env[`QWEN_EMAIL_${index}`]
    const password = env[`QWEN_PASSWORD_${index}`]
    if (email && password) {
      collected.push({ email, password })
    }
  }

  const byEmail = new Map<string, { email: string; password: string }>()
  for (const account of collected) {
    const email = account.email.trim()
    if (!email || !account.password || byEmail.has(email)) continue
    byEmail.set(email, { email, password: account.password })
  }

  return Array.from(byEmail.values())
}

function getCachedAccounts(): QwenAccount[] {
  const now = Date.now()
  if (!accountsCache || (now - accountsCacheTimestamp) > ACCOUNTS_CACHE_TTL) {
    const db = getDatabase()
    const rows = db.prepare('SELECT id, email, password, cooldown_until, cooldown_reason FROM accounts ORDER BY created_at ASC').all() as QwenAccount[]
    accountsCache = rows.map(row => ({
      ...row,
      password: decrypt(row.password),
    }))
    accountsCacheTimestamp = now
  }
  return accountsCache
}

export function invalidateAccountsCache(): void {
  accountsCache = null
  accountsCacheTimestamp = 0
}

export function loadAccounts(): QwenAccount[] {
  return getCachedAccounts().map(a => ({ ...a, password: '***' }))
}

export function addAccount(email: string, password: string, id?: string): QwenAccount {
  if (!email || typeof email !== 'string' || email.trim().length === 0) {
    throw new Error('Email is required')
  }

  const db = getDatabase()
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email.trim())
  if (existing) {
    throw new Error(`Account with email ${email} already exists`)
  }

  const encryptedPassword = encrypt(password)
  
  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  }

  db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)').run(
    newAccount.id,
    newAccount.email,
    encryptedPassword,
  )

  invalidateAccountsCache()
  return newAccount
}

export function importAccountsFromEnv(env: NodeJS.ProcessEnv = process.env): EnvAccountImportSummary {
  const envAccounts = collectEnvAccounts(env)
  const summary: EnvAccountImportSummary = {
    discovered: envAccounts.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
  }

  if (envAccounts.length === 0) return summary

  const db = getDatabase()
  const select = db.prepare('SELECT id, password FROM accounts WHERE email = ?')
  const insert = db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)')
  const update = db.prepare('UPDATE accounts SET password = ?, updated_at = datetime(\'now\') WHERE id = ?')

  const sync = db.transaction(() => {
    for (const account of envAccounts) {
      const email = account.email.trim()
      const encryptedPassword = encrypt(account.password)
      const existing = select.get(email) as { id: string; password: string } | undefined

      if (!existing) {
        insert.run(crypto.randomUUID(), email, encryptedPassword)
        summary.inserted++
        continue
      }

      try {
        const existingPassword = decrypt(existing.password)
        if (existingPassword !== account.password) {
          update.run(encryptedPassword, existing.id)
          summary.updated++
        } else {
          summary.skipped++
        }
      } catch {
        update.run(encryptedPassword, existing.id)
        summary.updated++
      }
    }
  })

  sync()
  invalidateAccountsCache()

  if (summary.inserted > 0 || summary.updated > 0) {
    console.log(`[Accounts] Synced ${envAccounts.length} account(s) from environment: inserted=${summary.inserted}, updated=${summary.updated}, unchanged=${summary.skipped}`)
  }

  return summary
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  if (result.changes > 0) {
    invalidateAccountsCache()
  }
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts()
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const cached = getCachedAccounts()
  return cached.find(a => a.id === id)
}

export function updateAccountCooldown(id: string, cooldownUntil: number, reason: string | null): void {
  const db = getDatabase()
  db.prepare('UPDATE accounts SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?').run(cooldownUntil, reason, id)
  invalidateAccountsCache()
}
