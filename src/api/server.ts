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
import { getBaseAccountId, makeAccountLaneId } from '../core/account-lanes.js'

const app = new Hono()

let watchdog: Watchdog
let server: any

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function randomDelay(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.min(minMs, maxMs))
  const max = Math.max(min, maxMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const limit = Math.max(1, concurrency)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

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

  const { loadAccounts, importAccountsFromEnv } = await import('../core/accounts.js')
  importAccountsFromEnv()
  const accounts = loadAccounts()

  const { initPlaywright, initPlaywrightForAccount } = await import('../services/playwright.js')

  if (accounts.length > 0) {
    const now = Date.now()
    let activeAccounts = accounts.filter(account => !account.cooldown_until || account.cooldown_until <= now)
    let cooldownAccounts = accounts.filter(account => account.cooldown_until && account.cooldown_until > now)

    if (config.accounts.singleAccountMode) {
      const selected = activeAccounts.find(account => {
        if (config.accounts.singleAccountId) return account.id === config.accounts.singleAccountId
        if (config.accounts.singleAccountEmail) return account.email === config.accounts.singleAccountEmail
        return true
      }) || activeAccounts[0]

      activeAccounts = selected
        ? Array.from({ length: config.accounts.lanes }, (_, index) => ({
          ...selected,
          id: makeAccountLaneId(selected.id, index + 1),
          email: `${selected.email}#lane-${index + 1}`,
        }))
        : []
      cooldownAccounts = selected ? [] : cooldownAccounts

      if (selected) {
        console.log(`[Server] Single account mode enabled: ${selected.email} with ${config.accounts.lanes} isolated lane(s).`)
      }
    }

    if (cooldownAccounts.length > 0) {
      console.log(`[Server] Skipping ${cooldownAccounts.length} account(s) on cooldown during startup.`)
    }

    console.log(`[Server] Initializing ${activeAccounts.length}/${accounts.length} configured account(s) with concurrency ${config.accounts.initConcurrency}...`)
    const { getAccountCredentials } = await import('../core/accounts.js')
    await runWithConcurrency(activeAccounts, config.accounts.initConcurrency, async (account, i) => {
      const creds = getAccountCredentials(getBaseAccountId(account.id))
      if (!creds) return
      const stagger = i === 0 ? 0 : randomDelay(config.accounts.initStaggerMinMs, config.accounts.initStaggerMaxMs)
      if (stagger > 0) await sleep(stagger)
      try {
        await initPlaywrightForAccount({ ...creds, id: account.id, email: account.email }, config.browser.headless)
      } catch (err: any) {
        console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
      }
    })
    if (config.precapture.headersStartup) {
      console.log(`[Server] Pre-capturing Qwen headers for ${activeAccounts.length} active account(s) with concurrency ${config.precapture.concurrency}...`)
      const { getQwenHeaders } = await import('../services/playwright.js')
      runWithConcurrency(activeAccounts, config.precapture.concurrency, async (account, i) => {
        const stagger = i === 0 ? 0 : randomDelay(config.precapture.staggerMinMs, config.precapture.staggerMaxMs)
        if (stagger > 0) await sleep(stagger)
        try {
          await getQwenHeaders(false, account.id)
        } catch (err: any) {
          console.warn(`[Server] Header pre-capture failed for ${account.email}:`, err.message)
        }
      }).catch(() => {})
    }
    if (config.warmPool.startup) {
      console.log(`[Server] Pre-fetching warm chats for ${activeAccounts.length} active account(s) in background...`)
      const { warmAllPools } = await import('../services/qwen.js')
      warmAllPools(activeAccounts.map(a => a.id)).catch(() => {})
    }
  } else {
    await initPlaywright(config.browser.headless)
  }

  const { startSessionKeeper } = await import('../services/session-keeper.js')
  startSessionKeeper()

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
    const { stopSessionKeeper } = await import('../services/session-keeper.js')
    stopSessionKeeper()
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
