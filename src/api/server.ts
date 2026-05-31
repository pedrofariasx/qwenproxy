import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions } from '../routes/chat.js'
import { chatResponses, responsesStop } from '../routes/responses.js'
import { openAIErrorBody } from '../core/openai-compat.js'
import { terminal } from '../core/terminal.ts'
import { debugEnabled } from '../core/debug-console.ts'
import { debugSearch } from '../core/debug-search.ts'
import { startDebugTui, stopDebugTui } from '../core/debug-tui.ts'

const app = new Hono()

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
  terminal.list('Server', 'Public routes', routeManifest)
  bootRecord('routes', routeManifest, ['startup', 'routes'])
}

let cache: MemoryCache
let watchdog: Watchdog
let server: any

app.use('*', async (c, next) => {
  const start = Date.now()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-QwenProxy-Client')
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204)
  }
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY ?? config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json(openAIErrorBody('Missing or invalid Authorization header', 401, {
        code: 'missing_api_key',
      }), 401)
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      return c.json(openAIErrorBody('Invalid API key', 401, {
        code: 'invalid_api_key',
      }), 401)
    }
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/responses', chatResponses)
app.post('/v1/responses', chatResponses)
app.post('/v1/chat/responses/stop', responsesStop)
app.post('/v1/responses/stop', responsesStop)
app.post('/v1/chat/responses/:response_id/cancel', responsesStop)
app.post('/v1/responses/:response_id/cancel', responsesStop)

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
  terminal.error('API', 'Unhandled request error', [err?.message || String(err)])
  return c.json(openAIErrorBody(err.message, 500), 500)
})

app.notFound((c) => c.json(openAIErrorBody(`Route not found: ${c.req.method} ${new URL(c.req.url).pathname}`, 404, {
  code: 'route_not_found',
}), 404))

export async function startServer(): Promise<void> {
  if (debugEnabled()) {
    startDebugTui()
    bootRecord('debug mode', [
      `mode: ${config.debug.mode}`,
      `max chars: ${config.debug.maxChars}`,
      `show prompt: ${config.debug.showPrompt ? 'yes' : 'no'}`,
      'terminal search: enabled',
    ], ['startup', 'debug'])
  }

  cache = new MemoryCache()
  await cache.connect()
  bootRecord('cache ready', ['backend: memory'], ['startup', 'cache'])
  logRouteManifest()

  const { loadAccounts } = await import('../core/accounts.ts')
  const { getDatabaseSummary } = await import('../core/database.ts')
  const accounts = loadAccounts()
  const db = getDatabaseSummary()
  terminal.info('Database', 'Account storage ready', [
    `path: ${db.path}`,
    `journal: ${db.journalMode}`,
    `accounts: ${db.accounts}`,
  ])
  bootRecord('database ready', [
    `path: ${db.path}`,
    `journal: ${db.journalMode}`,
    `accounts: ${db.accounts}`,
  ], ['startup', 'database'])

  if (accounts.length > 0) {
    terminal.info('Server', `Pre-warming ${accounts.length} configured account(s)`)
    bootRecord('account prewarm started', [
      `accounts: ${accounts.length}`,
      `headless: ${config.browser.headless ? 'yes' : 'no'}`,
    ], ['startup', 'account', 'prewarm'])
    const { initPlaywrightForAccount } = await import('../services/playwright.ts')

    void Promise.allSettled(
      accounts.map(async (account) => {
        const startedAt = Date.now()
        const accountTag = debugSearch.tagForId(account.id, 'acct')
        bootRecord('account init started', [
          `tag: #${accountTag}`,
          `email: ${account.email}`,
        ], ['startup', 'account'], [{ id: account.id, kind: 'acct' }])
        try {
          await initPlaywrightForAccount(account, config.browser.headless)
          terminal.success('Account', `${account.email} ready`, [
            `time: ${Date.now() - startedAt}ms`,
            `tag: #${accountTag}`,
            'route capture: deferred until first API request',
          ])
          bootRecord('account ready', [
            `tag: #${accountTag}`,
            `email: ${account.email}`,
            `time: ${Date.now() - startedAt}ms`,
          ], ['startup', 'account', 'ready'], [{ id: account.id, kind: 'acct' }])
        } catch (err: any) {
          terminal.error('Account', `Failed to initialize ${account.email}`, [err.message])
          bootRecord('account failed', [
            `tag: #${accountTag}`,
            `email: ${account.email}`,
            `error: ${err.message}`,
          ], ['startup', 'account', 'error'], [{ id: account.id, kind: 'acct' }])
        }
      })
    ).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected').length
      if (failed > 0) {
        terminal.warn('Server', `Pre-warm completed with ${failed} failure(s)`)
        bootRecord('prewarm completed', [`failed: ${failed}`], ['startup', 'prewarm', 'warn'])
      } else {
        terminal.success('Server', 'Pre-warm completed')
        bootRecord('prewarm completed', ['failed: 0'], ['startup', 'prewarm', 'ready'])
      }
    })
  } else {
    const { initPlaywright } = await import('../services/playwright.ts')
    bootRecord('global browser init started', [
      `headless: ${config.browser.headless ? 'yes' : 'no'}`,
    ], ['startup', 'browser'])
    await initPlaywright(config.browser.headless)
    bootRecord('global browser ready', ['profile: global'], ['startup', 'browser', 'ready'])
  }

  watchdog = new Watchdog()
  watchdog.start()
  bootRecord('watchdog started', [
    `interval: ${config.watchdog.checkInterval}ms`,
    `failures: ${config.watchdog.consecutiveFailuresThreshold}`,
  ], ['startup', 'watchdog'])

  metrics.startCollection()
  bootRecord('metrics started', [
    `interval: ${config.metrics.interval}ms`,
  ], ['startup', 'metrics'])

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    terminal.success('Server', `Listening on http://${info.address}:${info.port}`)
    bootRecord('server listening', [
      `url: http://${info.address}:${info.port}`,
      `api: http://${info.address}:${info.port}/v1`,
    ], ['startup', 'server', 'ready'])
  })

  server.on?.('clientError', (err: any, socket: any) => {
    const firstByte = err?.rawPacket?.[0]
    if (firstByte === 0x16) {
      terminal.warn('Server', 'HTTPS client connected to the HTTP port', [
        `received: TLS handshake on http://${config.server.host}:${config.server.port}`,
        `fix: use http://127.0.0.1:${config.server.port}/v1 in Zed/OpenCode/Codex settings`,
      ])
    }
    socket?.destroy?.()
  })

  const shutdown = async (signal: string) => {
    terminal.info('Server', `Received ${signal}; shutting down`)
    watchdog.stop()
    metrics.stopCollection()
    stopDebugTui()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.ts')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }

function bootRecord(
  title: string,
  lines: string[],
  tags: string[],
  ids: Array<{ id: string; kind?: string }> = [],
): void {
  if (!debugEnabled()) return
  const record = debugSearch.record({
    scope: 'Startup',
    title,
    lines,
    tags,
    ids,
  })
  terminal.debug('Startup', title, [
    `${record.tags.slice(0, 8).map((tag) => `#${tag}`).join(' ')}`,
    ...lines,
  ])
}
