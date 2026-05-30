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

export function loadAccounts(): QwenAccount[] {
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
