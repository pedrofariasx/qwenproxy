import 'dotenv/config'
import crypto from 'crypto'
import { getDatabase } from './database.ts'

export interface QwenAccount {
  id: string
  email: string
  password: string
}

function generateId(email: string): string {
  return crypto.createHash('md5').update(email).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}

function parseEnvAccounts(): QwenAccount[] {
  const envAccounts = process.env.QWEN_ACCOUNTS
  if (!envAccounts) return []

  return envAccounts.split(',').map((entry, index) => {
    const trimmed = entry.trim()
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      console.warn(`[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`)
      return null
    }
    const email = trimmed.substring(0, colonIdx)
    const password = trimmed.substring(colonIdx + 1)
    if (!email || !password) {
      console.warn(`[Accounts] Invalid QWEN_ACCOUNTS entry at index ${index}: "${trimmed}"`)
      return null
    }
    return {
      id: generateId(email),
      email: email.trim(),
      password: password.trim(),
    }
  }).filter((a): a is QwenAccount => a !== null)
}

let lastSyncedEnv = ''
let lastSyncTime = 0
const SYNC_INTERVAL = 30_000

function syncEnvAccounts(): void {
  const envAccounts = process.env.QWEN_ACCOUNTS || ''
  const now = Date.now()
  if (envAccounts === lastSyncedEnv && (now - lastSyncTime < SYNC_INTERVAL)) return

  lastSyncedEnv = envAccounts
  lastSyncTime = now

  const accounts = parseEnvAccounts()
  if (accounts.length === 0) return

  const db = getDatabase()
  const upsert = db.prepare(`
    INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET password = excluded.password, updated_at = datetime('now')
  `)

  const sync = db.transaction(() => {
    for (const acc of accounts) {
      upsert.run(acc.id, acc.email, acc.password)
    }
  })

  sync()
}

let accountsCache: QwenAccount[] | null = null
let accountsCacheTime = 0
const ACCOUNTS_CACHE_TTL = 5_000

export function loadAccounts(): QwenAccount[] {
  syncEnvAccounts()

  const now = Date.now()
  if (accountsCache && (now - accountsCacheTime < ACCOUNTS_CACHE_TTL)) return accountsCache

  const db = getDatabase()
  const rows = db.prepare('SELECT id, email, password FROM accounts ORDER BY created_at ASC').all()
  accountsCache = rows as QwenAccount[]
  accountsCacheTime = now
  return accountsCache
}

export function invalidateAccountsCache(): void {
  accountsCache = null
  accountsCacheTime = 0
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

  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email: email.trim(),
    password,
  }

  db.prepare('INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)').run(
    newAccount.id,
    newAccount.email,
    newAccount.password,
  )

  invalidateAccountsCache()
  return newAccount
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  invalidateAccountsCache()
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts().map(a => ({ id: a.id, email: a.email, password: '***' }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT id, email, password FROM accounts WHERE id = ?').get(id)
  return row as QwenAccount | undefined
}
