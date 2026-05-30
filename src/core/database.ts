import crypto from 'crypto'
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { Logger } from './logger.js'
import { config } from './config.js'

const logger = new Logger('info', 'Database')

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const ENCRYPTION_KEY_LENGTH = 32
const IV_LENGTH = 16

function getEncryptionKey(): Buffer | null {
  const passphrase = config.qwen.encryptionKey
  if (!passphrase) return null
  return crypto.scryptSync(passphrase, 'qwenproxy-salt', ENCRYPTION_KEY_LENGTH)
}

export function encryptPassword(password: string): string {
  const key = getEncryptionKey()
  if (!key) return password
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  let encrypted = cipher.update(password, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag()
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted
}

export function decryptPassword(encrypted: string): string {
  const key = getEncryptionKey()
  if (!key) return encrypted
  const parts = encrypted.split(':')
  if (parts.length !== 3) return encrypted
  const iv = Buffer.from(parts[0], 'hex')
  const tag = Buffer.from(parts[1], 'hex')
  const ciphertext = parts[2]
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

const DATA_DIR = path.resolve('data')
const DB_PATH = path.join(DATA_DIR, 'qwenproxy.db')

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (db) return db

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)

  // Enable WAL mode for better concurrent read performance (ideal for VPS)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -64000') // 64MB cache
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  migrateFromJson(db)

  // Fail fast in production mode if encryption key is not set
  if (process.env.NODE_ENV === 'production' && !config.qwen.encryptionKey) {
    throw new Error(
      'QWEN_ENCRYPTION_KEY is required when NODE_ENV=production. ' +
      'Set the environment variable to a secure passphrase for password encryption.'
    )
  }

  // Migrate plaintext passwords to encrypted on startup
  migratePlaintextPasswords(db)

  return db
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  `)
}

/**
 * Auto-migrate existing accounts.json into SQLite on first run.
 * The JSON file is renamed to accounts.json.bak after successful migration.
 */
function migrateFromJson(db: Database.Database): void {
  const jsonPath = path.resolve('accounts.json')
  if (!fs.existsSync(jsonPath)) return

  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8')
    const accounts = JSON.parse(raw) as Array<{ id: string; email: string; password: string }>

    if (!Array.isArray(accounts) || accounts.length === 0) {
      // Empty or invalid file — just rename it
      fs.renameSync(jsonPath, jsonPath + '.bak')
      return
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, email, password) VALUES (?, ?, ?)
    `)

    const migrate = db.transaction(() => {
      for (const account of accounts) {
        if (account.id && typeof account.email === 'string' && account.email.trim().length > 0) {
          insert.run(account.id, account.email.trim(), account.password || '')
        }
      }
    })

    migrate()

    // Rename old file to .bak to avoid re-migration
    fs.renameSync(jsonPath, jsonPath + '.bak')
    logger.info(`Migrated ${accounts.length} account(s) from accounts.json to SQLite`)
  } catch (err: any) {
    logger.error('[Database] Failed to migrate accounts.json: ' + (err as Error).message)
  }
}

function migratePlaintextPasswords(db: Database.Database): void {
  if (!config.qwen.encryptionKey) {
    logger.warn('QWEN_ENCRYPTION_KEY not set — passwords are stored in plaintext')
    return
  }

  // Detect plaintext passwords (the iv:tag:ciphertext format has two colons)
  const sample = db
    .prepare('SELECT password FROM accounts WHERE password != "" AND password NOT LIKE "%:%:%" LIMIT 1')
    .get() as { password: string } | undefined

  if (!sample) return // Already encrypted or no passwords present

  logger.info('Migrating plaintext passwords to encrypted...')
  const rows = db
    .prepare('SELECT id, password FROM accounts WHERE password != ""')
    .all() as Array<{ id: string; password: string }>

  const update = db.prepare('UPDATE accounts SET password = ? WHERE id = ?')

  const migration = db.transaction(() => {
    for (const row of rows) {
      update.run(encryptPassword(row.password), row.id)
    }
  })

  migration()
  logger.info(`Encrypted ${rows.length} password(s)`)
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
