import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions } from '../routes/chat.js'
import { chatResponses, responsesStop } from '../routes/responses.js'

const app = new Hono()
app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/responses', chatResponses)
app.post('/v1/responses', chatResponses)
app.post('/v1/chat/responses/stop', responsesStop)
app.post('/v1/responses/stop', responsesStop)
app.post('/v1/chat/responses/:response_id/cancel', responsesStop)
app.post('/v1/responses/:response_id/cancel', responsesStop)

const routeManifest = [
  'GET /health',
  'GET /metrics',
  'GET /v1/models',
  'GET /v1/models/:model',
  'POST /v1/chat/completions',
  'POST /v1/chat/responses',
  'POST /v1/responses',
  'POST /v1/chat/responses/stop',
  'POST /v1/responses/stop',
  'POST /v1/chat/responses/:response_id/cancel',
  'POST /v1/responses/:response_id/cancel',
]

function logRouteManifest(): void {
  console.log('[Server] Public routes:')
  for (const route of routeManifest) {
    console.log(`  - ${route}`)
  }
}

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

app.use('/v1/*', async (c, next) => {
  const apiKey = config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  return c.json({
    status: status?.overall || 'unknown',
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
  })
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  cache = new MemoryCache()
  await cache.connect()
  logRouteManifest()

  const { loadAccounts } = await import('../core/accounts.ts')
  const accounts = loadAccounts()

  if (accounts.length > 0) {
    console.log(`[Server] Pre-warming ${accounts.length} configured account(s)...`)
    const { initPlaywrightForAccount } = await import('../services/playwright.ts')

    void Promise.allSettled(
      accounts.map(async (account) => {
        const startedAt = Date.now()
        try {
          await initPlaywrightForAccount(account, config.browser.headless)
          console.log(`[Server] Account ${account.email} ready in ${Date.now() - startedAt}ms`)
          console.log(`[Server] Route capture for ${account.email} deferred until first API request`)
        } catch (err: any) {
          console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
        }
      })
    ).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length
      if (failed > 0) {
        console.warn(`[Server] Pre-warm completed with ${failed} failure(s)`)
      } else {
        console.log('[Server] Pre-warm completed')
      }
    })
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
    console.log(`Server listening on http://${info.address}:${info.port}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
