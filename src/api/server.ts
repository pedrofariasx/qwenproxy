import crypto from 'node:crypto'
import https from 'node:https'
import fs from 'node:fs'
import { Hono } from 'hono'
import { serve, getRequestListener } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { sanitizeError } from '../utils/error-sanitization.js'
import { Logger } from '../core/logger.js'
import { RateLimiter } from '../core/rate-limiter.js'

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
    requestLogger: Logger
  }
}

const logger = new Logger('info', 'Server')

const app = new Hono()

/** Server start timestamp used by /health to compute uptime. */
const startTime = Date.now()

/* Request ID tracking middleware — registered first so every request has an ID. */
app.use('*', async (c, next) => {
  let requestId = c.req.header('X-Request-Id')

  if (requestId) {
    // Validate: alphanumeric, hyphens, underscores, dots only, max 64 chars
    const isValid = /^[a-zA-Z0-9\-_.]{1,64}$/.test(requestId)
    if (!isValid) {
      requestId = crypto.randomUUID()
    }
  } else {
    requestId = crypto.randomUUID()
  }

  c.set('requestId', requestId)
  c.header('x-request-id', requestId)

  const requestLogger = logger.withRequestId(requestId)
  c.set('requestLogger', requestLogger)

  await next()
})

/* Security headers middleware — registered so they wrap all authenticated routes. */
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  if (config.ssl.enabled) {
    c.header('Strict-Transport-Security', 'max-age=31536000')
  }
  if (c.req.path.startsWith('/v1/')) {
    c.header('Cache-Control', 'no-store')
  }
  await next()
})

type StartupHealthStatus = 'unknown' | 'degraded' | 'ok'

interface StartupHealthState {
  cacheReady: boolean
  watchdogReady: boolean
  metricsReady: boolean
  prewarmComplete: boolean
  expectedSessions: number
  readySessions: number
  failedSessions: number
  errors: string[]
}

let cache: MemoryCache | null = null
let watchdog: Watchdog | null = null
let server: any

const startupHealthState: StartupHealthState = {
  cacheReady: false,
  watchdogReady: false,
  metricsReady: false,
  prewarmComplete: false,
  expectedSessions: 0,
  readySessions: 0,
  failedSessions: 0,
  errors: [],
}

function getStartupHealthStatus(state = startupHealthState): StartupHealthStatus {
  if (state.errors.some(error => error.startsWith('cache:') || error.startsWith('watchdog:'))) {
    return 'degraded'
  }
  if (!state.cacheReady || !state.watchdogReady) {
    return 'unknown'
  }
  if (!state.prewarmComplete) {
    return 'degraded'
  }
  // readySessions may be 0 with lazy Playwright init — not a degradation
  return 'ok'
}

export function getStartupHealthState() {
  return {
    ...startupHealthState,
    status: getStartupHealthStatus(),
  }
}

export function __setStartupHealthStateForTests(partial: Partial<StartupHealthState>): void {
  Object.assign(startupHealthState, partial)
}

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

  const startupStatus = getStartupHealthStatus()

  // Watchdog status — 3s timeout
  let watchdogStatus: any = null
  if (watchdog) {
    try {
      watchdogStatus = await Promise.race([
        watchdog.getStatus(),
        timeout(SUB_CHECK_TIMEOUT),
      ])
    } catch {
      // watchdog sub-check timed out
    }
  }

  // Cache stats — 3s timeout
  let cacheStats: any = null
  if (cache) {
    try {
      cacheStats = await Promise.race([
        cache.getStats(),
        timeout(SUB_CHECK_TIMEOUT),
      ])
    } catch {
      // cache sub-check timed out
    }
  }

  // Accounts info — 3s timeout
  let accountsInfo = { total: 0, inCooldown: 0 }
  try {
    const { getAccountCount, getCooldownStatus } = await import('../core/account-manager.js')
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

  // Playwright status — lightweight, no timeout needed (reads module-level state)
  let playwrightStatus = { initialized: false, activePage: false, accountPages: 0, captchaDetected: false }
  try {
    const { activePage: pwActivePage, isCaptchaDetected, accountPages: pwAccountPages } = await import('../services/playwright.js')
    playwrightStatus = {
      initialized: pwActivePage !== null,
      activePage: pwActivePage !== null,
      accountPages: pwAccountPages?.size ?? 0,
      captchaDetected: isCaptchaDetected(),
    }
  } catch {
    // playwright module not available
  }

  // Stream registry stats — 3s timeout
  let streamInfo = { active: 0 }
  try {
    const { getStreamCount } = await import('../core/stream-registry.js')
    const count = await Promise.race([
      Promise.resolve(getStreamCount()),
      timeout(SUB_CHECK_TIMEOUT),
    ])
    streamInfo = { active: count }
  } catch {
    // stream registry not available
  }

  // Memory info (instant, no async needed)
  const mem = process.memoryUsage()
  const memoryInfo = {
    rssMB: Math.round(mem.rss / (1024 * 1024)),
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    heapTotalMB: Math.round(mem.heapTotal / (1024 * 1024)),
    externalMB: Math.round(mem.external / (1024 * 1024)),
    heapUsagePercent: Math.round((mem.heapUsed / Math.max(mem.heapTotal, 1)) * 100),
  }

  return c.json({
    status: startupStatus,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: '1.0.0',
    startup: {
      status: startupStatus,
      cacheReady: startupHealthState.cacheReady,
      watchdogReady: startupHealthState.watchdogReady,
      metricsReady: startupHealthState.metricsReady,
      prewarmComplete: startupHealthState.prewarmComplete,
      expectedSessions: startupHealthState.expectedSessions,
      readySessions: startupHealthState.readySessions,
      failedSessions: startupHealthState.failedSessions,
      errors: startupHealthState.errors,
    },
    accounts: accountsInfo,
    watchdog: {
      healthy: watchdogStatus?.overall === 'healthy',
      details: watchdogStatus ?? null,
    },
    playwright: playwrightStatus,
    streams: streamInfo,
    memory: memoryInfo,
    timestamp: Date.now(),
    metrics: {
      cache: cacheStats,
    },
  })
})

// === ROTAS PROTEGIDAS POR API KEY (registre abaixo desta linha) ===

/** Verify the request carries a valid API key. Returns null on success or a 401 Response on failure. */
function verifyApiKey(c: any): Response | null {
  const apiKey = process.env.API_KEY || config.apiKey
  if (!apiKey) return null
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
  return null
}

app.use('/v1/*', async (c, next) => {
  const result = verifyApiKey(c)
  if (result !== null) return result
  if (!(process.env.API_KEY || config.apiKey)) {
    logger.warn('API_KEY is not set — all requests will be accepted without authentication')
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

/* Auth middleware for /metrics — keeps /health accessible without credentials. */
app.use('/metrics', async (c, next) => {
  const result = verifyApiKey(c)
  if (result !== null) return result
  await next()
})

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
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`)

    const cleanup = (async () => {
      watchdog?.stop()
      metrics.stopCollection()
      if (cache) {
        await cache.close()
      }
      const { closePlaywright } = await import('../services/playwright.js')
      await closePlaywright()
      const { closeDatabase } = await import('../core/database.js')
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

  const bootstrap = async () => {
    logger.info('Bootstrapping infrastructure in background...')

    try {
      cache = new MemoryCache()
      await cache.connect()
      startupHealthState.cacheReady = true
      logger.info('Memory cache is ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startupHealthState.errors.push(`cache: ${message}`)
      logger.error(`Cache initialization failed: ${message}`)
    }

    try {
      watchdog = new Watchdog()
      watchdog.start()
      startupHealthState.watchdogReady = true
      logger.info('Watchdog is ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startupHealthState.errors.push(`watchdog: ${message}`)
      logger.error(`Watchdog initialization failed: ${message}`)
    }

    metrics.startCollection()
    startupHealthState.metricsReady = true

    try {
      const { loadAccounts } = await import('../core/accounts.js')
      const accounts = loadAccounts()
      startupHealthState.expectedSessions = accounts.length > 0 ? accounts.length : 1
      logger.info(`Found ${accounts.length} configured account(s) — Playwright will start lazily on first request`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startupHealthState.errors.push(`accounts: ${message}`)
      logger.error(`Account loading failed: ${message}`)
    } finally {
      startupHealthState.readySessions = 0 // sessions start lazily
      startupHealthState.prewarmComplete = true
      logger.info('Startup health is ok (lazy Playwright init)')
    }
  }

  if (config.ssl.enabled) {
    const sslOptions: https.ServerOptions = {
      key: fs.readFileSync(config.ssl.keyPath, 'utf-8'),
      cert: fs.readFileSync(config.ssl.certPath, 'utf-8'),
    }
    const requestListener = getRequestListener(app.fetch)
    server = https.createServer(sslOptions, requestListener)
    server.listen(config.server.port, config.server.host, () => {
      logger.info(`Server listening on https://${config.server.host}:${config.server.port}`)
    })
  } else {
    server = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    }, (info) => {
      logger.info(`Server listening on http://${info.address}:${info.port}`)
    })
  }

  void bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    startupHealthState.errors.push(`bootstrap: ${message}`)
    logger.error(`Unexpected startup bootstrap failure: ${message}`)
  })

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
