import crypto from 'crypto'
import { getDatabase } from './database.ts'

export interface QwenAccount {
  id: string
  email: string
  password: string
  source?: 'database' | 'env'
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type AccountRow = {
  id: string
  email: string
  password: string
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') {
    throw new Error('Email must be a string')
  }
  const normalized = email.trim().toLowerCase()
  if (!normalized) {
    throw new Error('Email is required')
  }
  if (!EMAIL_RE.test(normalized)) {
    throw new Error(`Invalid email: ${email}`)
  }
  return normalized
}

function normalizePassword(password: unknown, allowEmpty: boolean): string {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string')
  }
  if (!allowEmpty && password.trim().length === 0) {
    throw new Error('Password is required for credential login. Use manual browser login for session-only accounts.')
  }
  return password
}

function uuidFromEmail(email: string): string {
  const hash = crypto.createHash('sha256').update(email).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

function loadAccountsFromEnv(): QwenAccount[] {
  const accounts: QwenAccount[] = []

  const addEnvAccount = (emailValue?: string, passwordValue?: string) => {
    if (!emailValue || !passwordValue) return
    const email = normalizeEmail(emailValue)
    accounts.push({
      id: uuidFromEmail(email),
      email,
      password: passwordValue,
      source: 'env',
    })
  }

  addEnvAccount(process.env.QWEN_EMAIL, process.env.QWEN_PASSWORD)

  for (let i = 1; i <= 20; i++) {
    addEnvAccount(process.env[`QWEN_EMAIL_${i}`], process.env[`QWEN_PASSWORD_${i}`])
  }

  return accounts
}

function loadAccountsFromDatabase(): QwenAccount[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT id, email, password
    FROM accounts
    ORDER BY datetime(created_at) ASC, email ASC
  `).all() as AccountRow[]

  return rows
    .map((row) => normalizeDatabaseRow(row))
    .filter((account): account is QwenAccount => Boolean(account))
}

function normalizeDatabaseRow(row: AccountRow): QwenAccount | null {
  if (!row || typeof row.id !== 'string' || !row.id.trim()) return null
  if (typeof row.email !== 'string' || !row.email.trim()) return null
  if (typeof row.password !== 'string') return null

  try {
    return {
      id: row.id.trim(),
      email: normalizeEmail(row.email),
      password: row.password,
      source: 'database',
    }
  } catch {
    return null
  }
}

function mergeAccounts(databaseAccounts: QwenAccount[], envAccounts: QwenAccount[]): QwenAccount[] {
  if (envAccounts.length === 0) return databaseAccounts
  if (databaseAccounts.length === 0) return envAccounts

  const merged = databaseAccounts.map((account) => ({ ...account }))
  const indexByEmail = new Map(merged.map((account, index) => [account.email, index]))

  for (const envAccount of envAccounts) {
    const existingIndex = indexByEmail.get(envAccount.email)
    if (existingIndex === undefined) {
      indexByEmail.set(envAccount.email, merged.length)
      merged.push(envAccount)
      continue
    }

    merged[existingIndex] = {
      ...merged[existingIndex],
      password: envAccount.password || merged[existingIndex].password,
    }
  }

  return merged
}

export function loadAccounts(): QwenAccount[] {
  const envAccounts = loadAccountsFromEnv()

  if (process.env.TEST_MOCK_PLAYWRIGHT && !process.env.QWENPROXY_DB_PATH) {
    return envAccounts.length > 0
      ? envAccounts
      : [{
        id: uuidFromEmail('mock@example.com'),
        email: 'mock@example.com',
        password: 'mock-password',
        source: 'env',
      }]
  }

  return mergeAccounts(loadAccountsFromDatabase(), envAccounts)
}

export function addAccount(email: string, password: string, id?: string): QwenAccount {
  const normalizedEmail = normalizeEmail(email)
  const accountId = id?.trim() || crypto.randomUUID()
  const normalizedPassword = normalizePassword(password, Boolean(id))
  const db = getDatabase()

  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(normalizedEmail) as { id: string } | undefined
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`)
  }

  const account: QwenAccount = {
    id: accountId,
    email: normalizedEmail,
    password: normalizedPassword,
    source: 'database',
  }

  db.prepare(`
    INSERT INTO accounts (id, email, password)
    VALUES (@id, @email, @password)
  `).run(account)

  return account
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts().map((account) => ({
    ...account,
    password: account.password ? '***' : '',
  }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const envAccounts = loadAccountsFromEnv()
  if (process.env.TEST_MOCK_PLAYWRIGHT && !process.env.QWENPROXY_DB_PATH) {
    return envAccounts.find((envAccount) => envAccount.id === id)
      ?? (id === uuidFromEmail('mock@example.com')
        ? {
          id,
          email: 'mock@example.com',
          password: 'mock-password',
          source: 'env',
        }
        : undefined)
  }

  const db = getDatabase()
  const row = db.prepare('SELECT id, email, password FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  const account = row ? normalizeDatabaseRow(row) : undefined

  if (!account) {
    return envAccounts.find((envAccount) => envAccount.id === id)
  }

  const envMatch = envAccounts.find((envAccount) => envAccount.email === account.email)
  if (!envMatch) return account

  return {
    ...account,
    password: envMatch.password || account.password,
  }
}
