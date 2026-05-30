import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'

export type CacheKey =
  | `auth:${string}`
  | `session:${string}`
  | `prompt:${string}`
  | `response:${string}`
  | `rate:${string}`

interface CacheEntry<T> {
  value: T
  expiresAt: number
  insertedAt: number
}

export class MemoryCache {
  private store: Map<string, CacheEntry<any>>
  private defaultTTL: number
  private prefix: string
  private cleanupInterval: NodeJS.Timeout | null
  private maxEntries: number

  constructor(options?: { prefix?: string; defaultTTL?: number; maxEntries?: number }) {
    this.prefix = options?.prefix || 'qwenproxy:'
    this.defaultTTL = options?.defaultTTL || config.cache.defaultTTL
    this.maxEntries = options?.maxEntries ?? config.cache.maxEntries
    this.store = new Map()
    this.cleanupInterval = null

    this.startCleanup()
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt <= now) {
          this.store.delete(key)
        }
      }
    }, 60000)
  }

  /** Evict entries when store exceeds maxEntries. Removes expired entries first, then oldest by insertion order. */
  private evict(): void {
    if (this.maxEntries <= 0) return
    if (this.store.size <= this.maxEntries) return

    const now = Date.now()
    // First pass: remove all expired entries
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key)
      }
    }
    // Second pass: if still over limit, remove oldest entries (Map iterates in insertion order)
    if (this.store.size > this.maxEntries) {
      const toDelete = this.store.size - this.maxEntries
      let deleted = 0
      for (const [key] of this.store.entries()) {
        if (deleted >= toDelete) break
        this.store.delete(key)
        deleted++
      }
    }
  }

  async connect(): Promise<void> {
    // No-op for in-memory cache
  }

  async set<T>(key: CacheKey, value: T, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value)
    const effectiveTTL = ttl || this.defaultTTL
    const fullKey = this.prefix + key

    this.store.set(fullKey, {
      value,
      expiresAt: Date.now() + (effectiveTTL * 1000),
      insertedAt: Date.now(),
    })

    this.evict()

    metrics.increment('cache.set')
    metrics.histogram('cache.value.size', Buffer.byteLength(serialized))
  }

  async get<T>(key: CacheKey): Promise<T | null> {
    const start = Date.now()
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    
    metrics.histogram('cache.get.latency', Date.now() - start)

    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.store.delete(fullKey)
      metrics.increment('cache.miss')
      return null
    }

    metrics.increment('cache.hit')
    return entry.value as T
  }

  async delete(key: CacheKey): Promise<void> {
    const fullKey = this.prefix + key
    this.store.delete(fullKey)
    metrics.increment('cache.deleted')
  }

  async exists(key: CacheKey): Promise<boolean> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.store.delete(fullKey)
      return false
    }
    return true
  }

  async setWithNX<T>(key: CacheKey, value: T, ttl?: number): Promise<boolean> {
    const fullKey = this.prefix + key
    if (this.store.has(fullKey)) {
      const entry = this.store.get(fullKey)
      if (entry && entry.expiresAt > Date.now()) {
        return false
      }
    }
    await this.set(key, value, ttl)
    return true
  }

  async increment(key: CacheKey, by: number = 1, ttl?: number): Promise<number> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    let current = 0
    
    if (entry && entry.expiresAt > Date.now()) {
      current = typeof entry.value === 'number' ? entry.value : 0
    }
    
    const newValue = current + by
    const effectiveTTL = ttl || this.defaultTTL
    
    this.store.set(fullKey, {
      value: newValue,
      expiresAt: Date.now() + (effectiveTTL * 1000),
      insertedAt: Date.now(),
    })
    
    return newValue
  }

  async getMulti<T>(keys: CacheKey[]): Promise<(T | null)[]> {
    return Promise.all(keys.map(key => this.get<T>(key)))
  }

  async scan(pattern: string, _count: number = 100): Promise<string[]> {
    const regex = new RegExp(this.prefix + pattern.replace(/\*/g, '.*'))
    const now = Date.now()
    const keys: string[] = []
    
    for (const [key, entry] of this.store.entries()) {
      if (regex.test(key) && entry.expiresAt > now) {
        keys.push(key)
      }
    }
    return keys
  }

  async flush(pattern?: string): Promise<void> {
    if (pattern) {
      const keys = await this.scan(pattern)
      for (const key of keys) {
        this.store.delete(key)
      }
    } else {
      this.store.clear()
    }
    metrics.increment('cache.flushed')
  }

  async getStats(): Promise<{
    connected: boolean
    keysCount?: number
    memoryUsage?: string
  }> {
    const now = Date.now()
    let validKeys = 0
    let totalBytes = 0
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt > now) {
        validKeys++
        totalBytes += Buffer.byteLength(JSON.stringify(entry.value)) + Buffer.byteLength(key)
      }
    }
    
    return {
      connected: true,
      keysCount: validKeys,
      memoryUsage: `${(totalBytes / 1024).toFixed(2)}KB`
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
  }
}
