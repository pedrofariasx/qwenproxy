import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface QwenAccount {
  id: string
  email: string
  password: string
}

const ACCOUNTS_FILE = path.resolve('accounts.json')

function isValidAccount(account: any): account is QwenAccount {
  return !!account
    && typeof account.id === 'string'
    && typeof account.email === 'string'
    && account.email.trim().length > 0
    && typeof account.password === 'string'
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
  for (let i = 1; i <= 20; i++) {
    const email = process.env[`QWEN_EMAIL_${i}`]
    const password = process.env[`QWEN_PASSWORD_${i}`]
    if (email && password) {
      accounts.push({ id: uuidFromEmail(email), email, password })
    }
  }
  return accounts
}

export function loadAccounts(): QwenAccount[] {
  const envAccounts = loadAccountsFromEnv()
  if (envAccounts.length > 0) {
    return envAccounts
  }

  const email = process.env.QWEN_EMAIL
  const password = process.env.QWEN_PASSWORD
  if (email && password) {
    return [{ id: uuidFromEmail(email), email, password }]
  }

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    return []
  }
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidAccount)
  } catch {
    return []
  }
}

function saveAccounts(accounts: QwenAccount[]): void {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
}

export function addAccount(email: string, password: string, id?: string): QwenAccount {
  const accounts = loadAccounts()
  const existing = accounts.find(a => a.email === email)
  if (existing) {
    throw new Error(`Account with email ${email} already exists`)
  }
  const newAccount: QwenAccount = {
    id: id || crypto.randomUUID(),
    email,
    password,
  }
  accounts.push(newAccount)
  saveAccounts(accounts)
  return newAccount
}

export function removeAccount(id: string): boolean {
  const accounts = loadAccounts()
  const filtered = accounts.filter(a => a.id !== id)
  if (filtered.length === accounts.length) {
    return false
  }
  saveAccounts(filtered)
  return true
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts().map(a => ({ id: a.id, email: a.email, password: '***' }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  return loadAccounts().find(a => a.id === id)
}
