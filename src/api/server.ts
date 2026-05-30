import crypto from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { sanitizeError } from '../utils/error-sanitization.js'
import { Logger } from '../core/logger.js'
import { RateLimiter } from '../core/rate-limiter.js'

const logger = new Logger('info', 'Server')

const app = new Hono()

/** Server start timestamp used by /health to compute uptime. */
const startTime = Date.now()

/* Security headers middleware — registered first so they wrap all routes. */
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Strict-Transport-Security', 'max-age=31536000')
  if (c.req.path.startsWith('/v1/')) {
    c.header('Cache-Control', 'no-store')
  }
  await next()
})

let cache: MemoryCache
let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

/* Body size limit middleware — block oversized requests early. */
app.use('/v1/*', async (c, next) => {
  const contentLength = parseInt(c.req.header('content-length') || '0', 10);
  if (contentLength > config.validation.MAX_REQUEST_BODY_BYTES) {
    return c.json({ error: { message: 'Request too large', type: 'invalid_request_error' } }, 413 as any);
  }
  await next();
})

/* Rate limiter middleware — conditionally registered. */
if (config.rateLimiter.enabled) {
  const rateLimiter = new RateLimiter(
    config.rateLimiter.max,
    config.rateLimiter.windowMs,
    config.rateLimiter.headerKey,
  );
  app.use('/v1/*', rateLimiter.middleware());
}

/**
 * Health check endpoint.
 *
 * Intentionally placed BEFORE the auth middleware so it remains accessible
 * without an API key. This allows load balancers, orchestration platforms
 * (Kubernetes, Docker), and monitoring tools to check service health
 * without carrying authentication credentials.
 */
const SUB_CHECK_TIMEOUT = 3000

app.get('/health', async (c) => {
  const timeout = (ms: number): Promise<never> =>
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))

  // Watchdog status — 3s timeout
  let watchdogStatus: any = null
  try {
    watchdogStatus = await Promise.race([
      watchdog?.getStatus() ?? Promise.resolve(null),
      timeout(SUB_CHECK_TIMEOUT),
    ])
  } catch {
    // watchdog sub-check timed out
  }

  // Cache stats — 3s timeout
  let cacheStats: any = null
  try {
    cacheStats = await Promise.race([
      cache?.getStats() ?? Promise.resolve(null),
      timeout(SUB_CHECK_TIMEOUT),
    ])
  } catch {
    // cache sub-check timed out
  }

  // Accounts info — 3s timeout
  let accountsInfo = { total: 0, inCooldown: 0 }
  try {
    const { getAccountCount, getCooldownStatus } = await import('../core/account-manager.ts')
    const info = await Promise.race([
      Promise.resolve({
        total: getAccountCount(),
        inCooldown: Object.keys(getCooldownStatus()).length,
      }),
      timeout(SUB_CHECK_TIMEOUT),
    ])
    accountsInfo = info
  } catch {
    // accounts sub-check timed out or unavailable
  }

  const isHealthy = watchdogStatus?.overall === 'healthy'

  return c.json({
    status: isHealthy ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: '1.0.0',
    accounts: accountsInfo,
    watchdog: {
      healthy: isHealthy,
      details: watchdogStatus ?? null,
    },
    timestamp: Date.now(),
    metrics: {
      cache: cacheStats,
    },
  })
})

// === ROTAS PROTEGIDAS POR API KEY (registre abaixo desta linha) ===
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    // Timing-safe comparison — first guard against length mismatch to avoid
    // crypto.timingSafeEqual throwing on unequal buffers.
    if (Buffer.byteLength(token, 'utf-8') !== Buffer.byteLength(apiKey, 'utf-8')) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
    if (!crypto.timingSafeEqual(Buffer.from(token, 'utf-8'), Buffer.from(apiKey, 'utf-8'))) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  } else {
    logger.warn('API_KEY is not set — all requests will be accepted without authentication')
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', err)
  const isProd = process.env.NODE_ENV === 'production'
  return c.json({ error: sanitizeError(err, isProd) }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  cache = new MemoryCache()
  await cache.connect()

  const { loadAccounts } = await import('../core/accounts.ts')
  const accounts = loadAccounts()

  if (accounts.length > 0) {
    logger.info(`Pre-warming ${accounts.length} configured account(s)...`)
    const { initPlaywrightForAccount } = await import('../services/playwright.ts')
    for (const account of accounts) {
      try {
        await initPlaywrightForAccount(account, config.browser.headless)
      } catch (err: any) {
        logger.error(`Failed to initialize account ${account.email}: ${(err as Error).message}`)
      }
    }
  } else {
    const { initPlaywright } = await import('../services/playwright.ts')
    await initPlaywright(config.browser.headless)
  }

  watchdog = new Watchdog()
  watchdog.start()

  metrics.startCollection()

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    logger.info(`Server listening on http://${info.address}:${info.port}`)
  })

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`)

    const cleanup = (async () => {
      watchdog.stop()
      metrics.stopCollection()
      await cache.close()
      const { closePlaywright } = await import('../services/playwright.js')
      await closePlaywright()
      const { closeDatabase } = await import('../core/database.ts')
      closeDatabase()
      server?.close()
    })()

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timeout')), config.shutdown.timeoutMs)
    })

    try {
      await Promise.race([cleanup, timeout])
      process.exit(0)
    } catch {
      logger.error(`Shutdown timed out after ${config.shutdown.timeoutMs}ms, forcing exit`)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
