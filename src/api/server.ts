import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import crypto from 'crypto'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { uploadFile } from '../routes/upload.js'

const app = new Hono()

let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    const tokenBuf = Buffer.from(token)
    const keyBuf = Buffer.from(apiKey)
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)
app.post('/v1/upload', uploadFile)

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
  await cache.connect()

  const { loadAccounts } = await import('../core/accounts.js')
  const accounts = loadAccounts()

  const { initPlaywright, initPlaywrightForAccount } = await import('../services/playwright.js')
  
  await initPlaywright(config.browser.headless)
  
  if (accounts.length > 0) {
    console.log(`[Server] Pre-warming ${accounts.length} configured account(s) in parallel...`)
    const { getAccountCredentials } = await import('../core/accounts.js')
    await Promise.all(
      accounts.map(account => {
        const creds = getAccountCredentials(account.id)
        if (!creds) return Promise.resolve()
        return initPlaywrightForAccount(creds, config.browser.headless).catch((err: any) => {
          console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
        })
      })
    )
    console.log('[Server] Pre-fetching headers for all accounts in background...')
    const { warmAllPools } = await import('../services/qwen.js')
    warmAllPools(accounts.map(a => a.id)).catch(() => {})
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
    const { closeDatabase } = await import('../core/database.js')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
