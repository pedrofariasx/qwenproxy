import crypto from 'crypto'
import { getDatabase, encryptPassword, decryptPassword } from './database.ts'

export interface QwenAccount {
  id: string
  email: string
  password: string
}

export function loadAccounts(): QwenAccount[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT id, email, password FROM accounts ORDER BY created_at ASC').all() as QwenAccount[]
  for (const row of rows) {
    row.password = decryptPassword(row.password)
  }
  return rows
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

  const encryptedPassword = encryptPassword(password)

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

  return newAccount
}

export function removeAccount(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  return result.changes > 0
}

export function listAccounts(): QwenAccount[] {
  return loadAccounts().map(a => ({ id: a.id, email: a.email, password: '***' }))
}

export function getAccountCredentials(id: string): QwenAccount | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT id, email, password FROM accounts WHERE id = ?').get(id) as QwenAccount | undefined
  if (row) {
    row.password = decryptPassword(row.password)
  }
  return row
}
