import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serve, type ServerType } from '@hono/node-server'
import { config } from '../core/config.js'
import { sleep } from '../utils/sleep.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { anthropicMessages } from '../routes/anthropic.js'
import { uploadFile } from '../routes/upload.js'
import { adminApp } from './admin.js'
import { getBaseAccountId, makeAccountLaneId } from '../core/account-lanes.js'

const app = new Hono()

let watchdog: Watchdog
let server: ServerType | undefined

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

  // Accurate error accounting by status: every 4xx/5xx response is an error.
  // (Previously only >=500 counted, so waves of 429/401 looked like "success".)
  const status = c.res.status
  if (status >= 500) {
    metrics.increment('requests.errors')
    metrics.increment('requests.5xx')
  } else if (status >= 400) {
    metrics.increment('requests.errors')
    metrics.increment('requests.4xx')
  }
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  const authRequired = config.authRequired || Boolean(apiKey)
  if (authRequired) {
    if (!apiKey) {
      return c.json({ error: 'AUTH_REQUIRED=true but no API_KEY is configured' }, 500)
    }
    const rawAuth = c.req.header('Authorization') || c.req.header('x-api-key')
    if (!rawAuth) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const auth = rawAuth.startsWith('Bearer ') ? rawAuth : `Bearer ${rawAuth}`
    const { resolveUserFromAuthHeader } = await import('../core/user-manager.js')
    const identity = resolveUserFromAuthHeader(auth)
    if (!identity) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
    ;(c as any).set('user', identity)
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', bodyLimit({
  maxSize: 52 * 1024 * 1024,
  onError: (c: Context) => c.json({ error: { message: 'Request body too large' } }, 413),
}), chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)
app.post('/v1/upload', uploadFile)
app.post('/v1/messages', bodyLimit({
  maxSize: 52 * 1024 * 1024,
  onError: (c: Context) => c.json({ error: { message: 'Request body too large' } }, 413),
}), anthropicMessages)
app.post('/v1/messages/count_tokens', bodyLimit({
  maxSize: 52 * 1024 * 1024,
  onError: (c: Context) => c.json({ error: { message: 'Request body too large' } }, 413),
}), async (c) => {
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }, 400)
  }
  const promptParts: string[] = []
  if (typeof body.system === 'string') {
    promptParts.push(body.system)
  } else if (Array.isArray(body.system)) {
    for (const s of body.system) {
      if (s && typeof s === 'object' && typeof s.text === 'string') {
        promptParts.push(s.text)
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') continue
      if (typeof m.content === 'string') {
        promptParts.push(m.content)
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && typeof b === 'object' && typeof b.text === 'string') {
            promptParts.push(b.text)
          }
        }
      }
    }
  }
  const { countTokens } = await import('../core/tokenizer.js')
  const fullText = promptParts.join('\n')
  return c.json({ input_tokens: Math.max(1, countTokens(fullText)) })
})

// Admin dashboard (served at /admin).
app.route('/admin', adminApp)

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
  metrics.increment('requests.5xx')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  await cache.connect()

  const { loadAccounts } = await import('../core/accounts.js')
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
  const { startTimeSeriesSampling, stopTimeSeriesSampling } = await import('../core/time-series.js')
  startTimeSeriesSampling()

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
    stopTimeSeriesSampling()
    metrics.stopCollection()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.js')
    closeDatabase()
    await new Promise<void>(resolve => {
      if (!server) return resolve()
      server.close(() => resolve())
      setTimeout(() => resolve(), 5000).unref()
    })
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
