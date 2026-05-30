import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { terminal } from './terminal.ts'

let db: Database.Database | null = null
let activeDbPath: string | null = null

type LegacyAccount = {
  id?: unknown
  email?: unknown
  password?: unknown
}

type NormalizedLegacyAccount = {
  id: string
  email: string
  password: string
}

function resolveDataDir(): string {
  return path.resolve(process.env.QWENPROXY_DATA_DIR || process.env.DATA_DIR || 'data')
}

export function getDatabasePath(): string {
  const configuredPath = process.env.QWENPROXY_DB_PATH
  if (configuredPath?.trim()) return path.resolve(configuredPath)
  return path.join(resolveDataDir(), 'qwenproxy.db')
}

export function getDatabase(): Database.Database {
  const dbPath = getDatabasePath()
  if (db && activeDbPath === dbPath) return db
  if (db) closeDatabase()

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  db = new Database(dbPath)
  activeDbPath = dbPath

  configureDatabase(db)
  runMigrations(db)
  migrateFromJson(db)

  return db
}

function configureDatabase(database: Database.Database): void {
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  database.pragma('synchronous = NORMAL')
  database.pragma('cache_size = -64000')
  database.pragma('foreign_keys = ON')
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    CREATE TABLE IF NOT EXISTS account_runtime (
      account_id TEXT PRIMARY KEY,
      last_used_at TEXT,
      cooldown_until INTEGER,
      cooldown_reason TEXT,
      last_error TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  database.prepare(`
    INSERT INTO meta (key, value, updated_at)
    VALUES ('schema_version', '2', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run()
}

function migrateFromJson(database: Database.Database): void {
  if (process.env.QWENPROXY_SKIP_JSON_MIGRATION === 'true') return

  const jsonPath = path.resolve('accounts.json')
  if (!fs.existsSync(jsonPath)) return

  let raw = ''
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8')
  } catch (err: any) {
    terminal.error('Database', 'Could not read accounts.json', [err.message])
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: any) {
    terminal.error('Database', 'accounts.json is not valid JSON; keeping it untouched', [err.message])
    return
  }

  if (!Array.isArray(parsed)) {
    const backupPath = moveLegacyFile(jsonPath)
    terminal.warn('Database', 'accounts.json was not an array; moved to backup', [backupPath])
    return
  }

  const accounts = parsed
    .map(normalizeLegacyAccount)
    .filter((account): account is NormalizedLegacyAccount => Boolean(account))

  const insert = database.prepare(`
    INSERT INTO accounts (id, email, password)
    VALUES (@id, @email, @password)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      updated_at = datetime('now')
  `)

  const migrate = database.transaction((rows: NormalizedLegacyAccount[]) => {
    for (const account of rows) {
      insert.run(account)
    }
  })

  migrate(accounts)
  const backupPath = moveLegacyFile(jsonPath)
  terminal.success('Database', `Migrated ${accounts.length}/${parsed.length} account(s) from accounts.json`, [
    `SQLite: ${getDatabasePath()}`,
    `Backup: ${backupPath}`,
  ])
}

function normalizeLegacyAccount(account: LegacyAccount): NormalizedLegacyAccount | null {
  if (!account || typeof account !== 'object') return null

  const email = normalizeEmail(account.email)
  if (!email) return null

  const id = typeof account.id === 'string' && account.id.trim()
    ? account.id.trim()
    : uuidFromEmail(email)

  return {
    id,
    email,
    password: typeof account.password === 'string' ? account.password : '',
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
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

function moveLegacyFile(filePath: string): string {
  const preferred = `${filePath}.bak`
  let backupPath = preferred
  if (fs.existsSync(backupPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = `${filePath}.${stamp}.bak`
  }
  fs.renameSync(filePath, backupPath)
  return backupPath
}

export function closeDatabase(): void {
  if (!db) return
  try {
    db.pragma('optimize')
  } catch {
    // Best-effort cleanup only.
  }
  db.close()
  db = null
  activeDbPath = null
}

export function getDatabaseSummary(): {
  path: string
  journalMode: string
  accounts: number
  runtimeRows: number
} {
  const database = getDatabase()
  const accounts = database.prepare('SELECT COUNT(*) AS total FROM accounts').get() as { total: number }
  const runtimeRows = database.prepare('SELECT COUNT(*) AS total FROM account_runtime').get() as { total: number }
  return {
    path: getDatabasePath(),
    journalMode: String(database.pragma('journal_mode', { simple: true })),
    accounts: accounts.total,
    runtimeRows: runtimeRows.total,
  }
}
