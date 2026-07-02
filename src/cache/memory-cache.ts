import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'

export type CacheKey =
  | `auth:${string}`
  | `session:${string}`
  | `prompt:${string}`
  | `response:${string}`
  | `rate:${string}`
  | `models:${string}`

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class MemoryCache {
  private store: Map<string, CacheEntry<any>>
  private defaultTTL: number
  private prefix: string
  private cleanupInterval: NodeJS.Timeout | null
  private maxEntries: number
  private totalBytes: number
  private scanRegexCache: Map<string, RegExp>

  constructor(options?: { prefix?: string; defaultTTL?: number; maxEntries?: number }) {
    this.prefix = options?.prefix || 'qwenproxy:'
    this.defaultTTL = options?.defaultTTL || config.cache.defaultTTL
    this.maxEntries = options?.maxEntries || 10000
    this.store = new Map()
    this.totalBytes = 0
    this.cleanupInterval = null
    this.scanRegexCache = new Map()

    this.startCleanup()
  }

  private entryByteSize(key: string, value: any): number {
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value)
    return Buffer.byteLength(key) + Buffer.byteLength(valueStr || '')
  }

  private evictLRU(): void {
    const oldest = this.store.keys().next()
    if (!oldest.done) {
      const evicted = this.store.get(oldest.value)
      if (evicted) this.totalBytes -= this.entryByteSize(oldest.value, evicted.value)
      this.store.delete(oldest.value)
      metrics.increment('cache.evicted')
    }
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

  async connect(): Promise<void> {
    // No-op for in-memory cache
  }

  async set<T>(key: CacheKey, value: T, ttl?: number): Promise<void> {
    const effectiveTTL = ttl || this.defaultTTL
    const fullKey = this.prefix + key
    const entrySize = this.entryByteSize(fullKey, value)
    
    if (this.store.has(fullKey)) {
      const oldEntry = this.store.get(fullKey)
      if (oldEntry) this.totalBytes -= this.entryByteSize(fullKey, oldEntry.value)
    } else {
      while (this.store.size >= this.maxEntries) {
        this.evictLRU()
      }
    }
    
    this.store.set(fullKey, {
      value,
      expiresAt: Date.now() + (effectiveTTL * 1000)
    })
    this.totalBytes += entrySize
    
    metrics.increment('cache.set')
    metrics.histogram('cache.value.size', entrySize)
  }

  async get<T>(key: CacheKey): Promise<T | null> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)

    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) {
        this.totalBytes -= this.entryByteSize(fullKey, entry.value)
        this.store.delete(fullKey)
      }
      metrics.increment('cache.miss')
      return null
    }

    metrics.increment('cache.hit')
    return entry.value as T
  }

  async delete(key: CacheKey): Promise<void> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    if (entry) {
      this.totalBytes -= this.entryByteSize(fullKey, entry.value)
      this.store.delete(fullKey)
      metrics.increment('cache.deleted')
    }
  }

  async exists(key: CacheKey): Promise<boolean> {
    const fullKey = this.prefix + key
    const entry = this.store.get(fullKey)
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) {
        this.totalBytes -= this.entryByteSize(fullKey, entry.value)
        this.store.delete(fullKey)
      }
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
      expiresAt: Date.now() + (effectiveTTL * 1000)
    })
    
    return newValue
  }

  async getMulti<T>(keys: CacheKey[]): Promise<(T | null)[]> {
    return Promise.all(keys.map(key => this.get<T>(key)))
  }

  async scan(pattern: string, _count: number = 100): Promise<string[]> {
    let regex = this.scanRegexCache.get(pattern)
    if (!regex) {
      regex = new RegExp(this.prefix + pattern.replace(/\*/g, '.*'))
      this.scanRegexCache.set(pattern, regex)
    }
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
    return {
      connected: true,
      keysCount: this.store.size,
      memoryUsage: `${(this.totalBytes / 1024).toFixed(2)}KB`
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
    this.totalBytes = 0
  }
}

export const cache = new MemoryCache()
