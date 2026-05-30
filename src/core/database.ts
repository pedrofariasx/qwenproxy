import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

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
    console.log(`[Database] Migrated ${accounts.length} account(s) from accounts.json to SQLite`)
  } catch (err: any) {
    console.error('[Database] Failed to migrate accounts.json:', err.message)
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
