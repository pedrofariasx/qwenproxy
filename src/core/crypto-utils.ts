import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const DATA_DIR = path.resolve('data')
const KEY_PATH = path.join(DATA_DIR, '.encryption_key')
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const KEY_LENGTH = 32

let cachedKey: Buffer | null = null

function getOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey

  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    cachedKey = crypto.scryptSync(envKey, 'qwenproxy-salt', KEY_LENGTH)
    return cachedKey
  }

  if (fs.existsSync(KEY_PATH)) {
    cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf-8'), 'hex')
    return cachedKey
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  const newKey = crypto.randomBytes(KEY_LENGTH)
  fs.writeFileSync(KEY_PATH, newKey.toString('hex'), { mode: 0o600 })
  cachedKey = newKey
  return cachedKey
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return ''
  const key = getOrCreateKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ''
  if (!ciphertext.includes(':')) return ciphertext

  const parts = ciphertext.split(':')
  if (parts.length !== 3) return ciphertext

  try {
    const key = getOrCreateKey()
    const iv = Buffer.from(parts[0], 'hex')
    const authTag = Buffer.from(parts[1], 'hex')
    const encrypted = Buffer.from(parts[2], 'hex')
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return decipher.update(encrypted).toString('utf-8') + decipher.final('utf-8')
  } catch {
    return ciphertext
  }
}

export function isEncrypted(value: string): boolean {
  if (!value) return false
  const parts = value.split(':')
  if (parts.length !== 3) return false
  return parts.every(p => /^[0-9a-f]+$/i.test(p))
}
