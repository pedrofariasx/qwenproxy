/**
 * Admin dashboard backend: authenticated API for accounts, API keys, essential
 * settings, metrics and runtime actions.
 */

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { addAccount, removeAccount, listAccounts } from '../core/accounts.js'
import { getWarmPoolStats } from '../services/warm-pool.js'
import {
  getAccountCooldownInfo,
  getAccountActiveLoad,
  getInUseAccounts,
  clearAccountCooldown,
  isAccountReady,
  getReadyAccountCount,
} from '../core/account-manager.js'
import { getIsolationStatus, getFingerprintSalt, getResourceVersion } from '../core/account-isolation.js'
import { getFingerprintProfile } from '../services/fingerprint.js'
import { makeAccountLaneId } from '../core/account-lanes.js'
import { getPersonalization, savePersonalization, applyPersonalizationToAccount, applyPersonalizationToAll, hasPersonalization } from '../services/personalization.js'
import { listUsers, upsertUser, deleteUserById, getUserById, listSessions } from '../core/database.js'
import { getUserActiveStreams } from '../core/user-manager.js'
import { getSessionCount, removeSession, resetAllSessions } from '../services/session-manager.js'
import { getStreamRegistry, abortStream } from '../core/stream-registry.js'
import { getRecentToolCalls } from '../core/tool-call-debug.js'
import { getAllSeries } from '../core/time-series.js'
import { readEnvFile, persistEnvPatch, restartServer, SETTINGS_ALLOWLIST, SETTINGS_SECRETS, BOOLEAN_KEYS, INTEGER_KEYS } from '../core/env-settings.js'
import { LIVE_KEYS, applyRuntimeSetting, getLiveSettings, getRuntimeBool } from '../core/runtime-config.js'
import { logBuffer } from '../core/log-buffer.js'
import { getTopUsers, getModelUsage } from '../core/usage-tracker.js'
import { getModelContextWindow } from '../core/model-registry.js'
import { fetchFullModelCatalog } from './models.js'
import { sleep } from '../utils/sleep.js'

function randomDelay(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.min(minMs, maxMs))
  const max = Math.max(min, maxMs)
  return min + Math.floor(Math.random() * (max - min + 1))
}

export const adminApp = new Hono()

const COOKIE_NAME = 'qadmin'
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days

const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const loginFailures = new Map<string, number[]>()

function clientIp(c: any): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.env?.incoming?.socket?.remoteAddress ||
    'unknown'
  )
}

function isLoginBlocked(ip: string): boolean {
  const now = Date.now()
  const recent = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS)
  loginFailures.set(ip, recent)
  return recent.length >= LOGIN_MAX_FAILURES
}

function recordLoginFailure(ip: string): void {
  const now = Date.now()
  const recent = (loginFailures.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS)
  recent.push(now)
  loginFailures.set(ip, recent)
}

function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip)
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function adminPassword(): string {
  // ADMIN_PASSWORD first; fall back to the proxy API key so operators with a
  // key already set do not need extra config.
  return config.adminPassword || (process.env.API_KEY || config.apiKey) || ''
}

function signSession(expiresAt: number): string {
  const payload = `${expiresAt}:${crypto.randomUUID()}`
  const sig = crypto.createHmac('sha256', `qwenproxy:${adminPassword()}`).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

function verifySession(c: any): boolean {
  const token = getCookie(c, COOKIE_NAME)
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot === -1) return false
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', `qwenproxy:${adminPassword()}`).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  const [expiresAt] = payload.split(':')
  return Number(expiresAt) > Date.now()
}

async function adminGuard(c: any, next: any) {
  const enabled = adminPassword() !== ''
  if (!enabled) {
    return c.json({ error: 'Admin dashboard disabled. Set ADMIN_PASSWORD (or API_KEY) in .env.' }, 503)
  }
  if (!verifySession(c)) {
    return c.json({ error: 'Não autenticado' }, 401)
  }
  await next()
}

// --- Auth -------------------------------------------------------------------

adminApp.post('/api/login', async (c) => {
  const ip = clientIp(c)
  if (isLoginBlocked(ip)) {
    return c.json({ error: 'Muitas tentativas. Aguarde alguns minutos.' }, 429)
  }
  const body = await c.req.json().catch(() => null)
  const password = String(body?.password || '')
  const expected = adminPassword()
  if (!expected) {
    return c.json({ error: 'Dashboard admin desabilitado. Configure ADMIN_PASSWORD no .env.' }, 503)
  }
  const a = Buffer.from(password)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordLoginFailure(ip)
    return c.json({ error: 'Senha incorreta' }, 401)
  }
  clearLoginFailures(ip)
  const expiresAt = Date.now() + COOKIE_MAX_AGE * 1000
  setCookie(c, COOKIE_NAME, signSession(expiresAt), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: c.req.header('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  })
  return c.json({ ok: true, expiresAt })
})

adminApp.post('/api/logout', async (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  return c.json({ ok: true })
})

adminApp.get('/api/session', (c) => {
  const enabled = adminPassword() !== ''
  if (!enabled) return c.json({ authenticated: false, enabled: false, reason: 'ADMIN_PASSWORD not set' })
  return c.json({
    authenticated: verifySession(c),
    enabled: true,
    uptime: Math.floor(process.uptime()),
    version: readPackageVersion(),
  })
})

// --- Overview / metrics -----------------------------------------------------

adminApp.get('/api/overview', adminGuard, async (c) => {
  return c.json(await buildOverview())
})

async function buildOverview(): Promise<any> {
  const requestsTotal = (metrics.get('requests.total')?.value as number) || 0
  const errors = (metrics.get('requests.errors')?.value as number) || 0
  const requests4xx = (metrics.get('requests.4xx')?.value as number) || 0
  const requests5xx = (metrics.get('requests.5xx')?.value as number) || 0
  const requestsCompletions = (metrics.get('requests.completions')?.value as number) || 0
  const latency = metrics.get('latency.request')?.value as any
  const latencyCompletion = metrics.get('latency.completion')?.value as any

  const users = listUsers()
  let totalUserStreams = getUserActiveStreams('global')
  const userList = users.map(u => {
    const streams = getUserActiveStreams(u.id)
    totalUserStreams += streams
    return { id: u.id, email: u.email, streams }
  })

  // Real per-account stream counts from the stream registry.
  const streamCounts = new Map<string, number>()
  for (const s of getStreamRegistry().values()) {
    const acct = s.accountId || 'unknown'
    streamCounts.set(acct, (streamCounts.get(acct) || 0) + 1)
  }

  const accounts = listAccounts().map(a => ({
    id: a.id,
    email: a.email,
    cooldown: getAccountCooldownInfo(a.id)?.remainingMs ?? 0,
    cooldownReason: getAccountCooldownInfo(a.id)?.reason ?? null,
    activeLoad: getAccountActiveLoad(a.id),
    ready: isAccountReady(a.id),
    streams: streamCounts.get(a.id) || 0,
  }))
  const inUse = getInUseAccounts()

  const mem = process.memoryUsage()
  const systemTotal = os.totalmem()
  const memoryPct = systemTotal > 0 ? Number(((mem.rss / systemTotal) * 100).toFixed(1)) : 0

  return {
    uptime: Math.floor(process.uptime()),
    startedAt: Math.floor(Date.now() / 1000) - Math.floor(process.uptime()),
    watchdog: {
      overall: (metrics.get('watchdog.overall')?.value as number) || 0,
      ram: (metrics.get('watchdog.ram.status')?.value as number) || 0,
    },
    requestsTotal,
    requestsCompletions,
    requestsErrors: errors,
    requests4xx,
    requests5xx,
    requestsSuccessRate: requestsTotal > 0 ? Math.max(0, (1 - errors / requestsTotal) * 100) : 100,
    latency: latency && typeof latency === 'object' ? { sum: latency.sum, count: latency.count } : undefined,
    latencyCompletion: latencyCompletion && typeof latencyCompletion === 'object'
      ? { sum: latencyCompletion.sum, count: latencyCompletion.count }
      : undefined,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      systemTotal,
      pct: memoryPct,
    },
    cpu: { cores: os.cpus().length, load1m: os.loadavg()[0] },
    series: getAllSeries(),
    cache: (await (cache as any).getStats?.()) || undefined,
    accounts,
    inUseAccounts: [...inUse],
    users: userList,
    totalUserStreams,
    activeStreamsMetric: (metrics.get('streams.active')?.value as number) || 0,
    warmPool: getWarmPoolStats(),
    sessionCount: getSessionCount(),
    guestMode: getRuntimeBool('QWEN_GUEST_MODE_ONLY', false),
    singleAccountMode: config.accounts.singleAccountMode,
    lanes: config.accounts.lanes,
    maxStreamsPerAccount: config.accounts.maxStreamsPerAccount,
    streamSlotWaitMs: config.accounts.streamSlotWaitMs,
    readyAccountCount: getReadyAccountCount(),
    isolation: getIsolationStatus(),
    userRateLimitRpm: config.users.defaultRateLimitRpm,
    userMaxConcurrency: config.users.defaultMaxConcurrency,
    hybridVerify: config.hybridSessions.verify,
  }
}

// --- Live stream (server-sent events) ----------------------------------------
// A single long-lived connection pushes an overview snapshot every few seconds,
// so the dashboard updates in real time with exactly ONE open request instead of
// repeated HTTP polling.

const LIVE_INTERVAL_MS = 3000

adminApp.get('/api/live', adminGuard, (c) => {
  return streamSSE(c, async (stream) => {
    const send = async () => {
      try {
        const payload = await buildOverview()
        await stream.writeSSE({ data: JSON.stringify(payload) })
      } catch { /* client gone */ }
    }

    try {
      await send()
      while (true) {
        await stream.sleep(LIVE_INTERVAL_MS)
        if (c.req.raw.signal.aborted || stream.closed) break
        await send()
      }
    } catch {
      // Client disconnected — stop the loop.
    }
  })
})

// --- Accounts ---------------------------------------------------------------

adminApp.get('/api/accounts', adminGuard, (c) => {
  const accounts = listAccounts().map(a => ({
    ...a,
    password: '***',
    cooldown: getAccountCooldownInfo(a.id)?.remainingMs ?? 0,
    cooldownReason: getAccountCooldownInfo(a.id)?.reason ?? null,
    activeLoad: getAccountActiveLoad(a.id),
    ready: isAccountReady(a.id),
  }))
  return c.json({ accounts, inUse: [...getInUseAccounts()], maxStreamsPerAccount: config.accounts.maxStreamsPerAccount })
})

// Brings a freshly-added account online IMMEDIATELY (browser context + anti-bot
// header precapture + warm pool) so it is usable the moment the dashboard call
// returns — no server restart required. Mirrors the per-account startup path in
// server.ts but for a single account, launched in the background.
async function kickoffAccountInitialization(account: { id: string; email: string }): Promise<void> {
  const { getAccountCredentials } = await import('../core/accounts.js')
  const { initPlaywrightForAccount, getQwenHeaders } = await import('../services/playwright.js')
  const creds = getAccountCredentials(account.id)
  if (!creds) return

  const stagger = randomDelay(config.accounts.initStaggerMinMs, config.accounts.initStaggerMaxMs)
  if (stagger > 0) await sleep(stagger)

  try {
    await initPlaywrightForAccount({ ...creds, id: account.id, email: account.email }, config.browser.headless)
    console.log(`[Admin] Browser context initialized for new account ${account.email}`)
  } catch (err: any) {
    console.error(`[Admin] Failed to initialize browser context for ${account.email}:`, err.message)
  }

  if (config.precapture.headersStartup) {
    try {
      await getQwenHeaders(false, account.id)
      console.log(`[Admin] Anti-bot headers pre-captured for ${account.email}`)
    } catch (err: any) {
      console.warn(`[Admin] Header pre-capture failed for ${account.email}:`, err.message)
    }
  }

  if (config.warmPool.startup) {
    const { warmAllPools } = await import('../services/qwen.js')
    warmAllPools([account.id]).catch(() => {})
  }

  // If a shared personalization is configured, push it to the new account so it
  // immediately matches every other account's identity/voice.
  if (hasPersonalization()) {
    try {
      const r = await applyPersonalizationToAccount(account.id)
      if (r.ok) console.log(`[Admin] Personalization applied to new account ${account.email}`)
      else console.warn(`[Admin] Personalization skipped for ${account.email}: ${r.error}`)
    } catch (err: any) {
      console.warn(`[Admin] Personalization failed for ${account.email}:`, err?.message)
    }
  }
}

adminApp.post('/api/accounts', adminGuard, async (c) => {
  const body: any = await c.req.json().catch(() => null)
  const email = String(body?.email || '').trim()
  const password = String(body?.password || '')
  if (!email || !password) return c.json({ error: 'email e password são obrigatórios' }, 400)
  try {
    const account = addAccount(email, password)
    // Proactively bring the account online so it is usable immediately (no restart).
    kickoffAccountInitialization(account).catch((err) => {
      console.error(`[Admin] Account initialization failed for ${email}:`, err?.message)
    })
    return c.json({ ok: true, account: { ...account, password: '***' }, initializing: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

adminApp.delete('/api/accounts/:id', adminGuard, (c) => {
  const id = c.req.param('id')
  const removed = removeAccount(id)
  return c.json({ ok: removed })
})

adminApp.post('/api/accounts/:id/clear-cooldown', adminGuard, (c) => {
  // Clears BOTH the in-memory cooldown (which getAccountCooldownInfo checks
  // first) and the persisted DB row. updateAccountCooldown(id,0,null) would
  // only clear the DB and leave the account stuck on cooldown in memory.
  clearAccountCooldown(c.req.param('id'))
  return c.json({ ok: true })
})

adminApp.post('/api/accounts/:id/refresh', adminGuard, async (c) => {
  try {
    const { getQwenHeaders } = await import('../services/playwright.js')
    const { headers } = await getQwenHeaders(true, c.req.param('id'))
    return c.json({ ok: true, cookie: Boolean(headers?.cookie), bxUa: Boolean(headers?.['bx-ua']) })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

adminApp.get('/api/accounts/:id/fingerprint', adminGuard, async (c) => {
  const id = c.req.param('id')
  const salt = getFingerprintSalt(id)
  const resourceVersion = getResourceVersion(id)
  const profile = getFingerprintProfile(id)
  // In single-account mode each account is expanded into isolated lanes, and
  // every lane gets its OWN distinct device fingerprint — surface them too.
  const lanes = config.accounts.singleAccountMode
    ? Array.from({ length: config.accounts.lanes }, (_, i) => {
        const laneId = makeAccountLaneId(id, i + 1)
        return { lane: i + 1, id: laneId, profile: getFingerprintProfile(laneId) }
      })
    : []
  return c.json({ accountId: id, salt, resourceVersion, profile, lanes })
})

// --- Qwen personalization (shared across all accounts) ----------------------

adminApp.get('/api/personalization', adminGuard, (c) => {
  return c.json(getPersonalization())
})

adminApp.post('/api/personalization', adminGuard, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'payload inválido' }, 400)
  const saved = savePersonalization(body)
  return c.json({ ok: true, config: saved })
})

adminApp.post('/api/personalization/apply', adminGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const accountId = body?.accountId ? String(body.accountId) : undefined
  let results
  if (accountId) {
    results = [await applyPersonalizationToAccount(accountId)]
  } else {
    results = await applyPersonalizationToAll()
  }
  const succeeded = results.filter((r) => r.ok).length
  return c.json({
    ok: true,
    applied: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  })
})

// --- Active streams -------------------------------------------------------

adminApp.get('/api/streams', adminGuard, (c) => {
  const now = Date.now()
  const streams = [...getStreamRegistry().entries()].map(([key, s]) => ({
    key,
    accountId: s.accountId,
    uiSessionId: s.uiSessionId,
    targetResponseId: s.targetResponseId,
    createdAt: s.createdAt,
    ageMs: now - s.createdAt,
  }))
  return c.json({ streams })
})

adminApp.post('/api/streams/:key/stop', adminGuard, async (c) => {
  try {
    const stopped = await abortStream(c.req.param('key'))
    return c.json({ ok: stopped })
  } catch {
    return c.json({ ok: false, transport_stopped: false, error: 'Transport teardown failed' }, 502)
  }
})

// --- Bulk actions / exports -----------------------------------------------

adminApp.get('/api/debug/toolcalls', adminGuard, (c) => {
  return c.json({ toolCalls: getRecentToolCalls() })
})

adminApp.post('/api/clear-cooldowns', adminGuard, (c) => {
  const accounts = listAccounts()
  for (const a of accounts) clearAccountCooldown(a.id)
  return c.json({ ok: true, cleared: accounts.length })
})

adminApp.get('/api/metrics/export', adminGuard, (c) => {
  return c.body(metrics.formatPrometheus(), 200, {
    'Content-Type': 'text/plain; version=0.0.4',
    'Content-Disposition': 'attachment; filename="qwenproxy-metrics.txt"',
  })
})

// --- Users / API keys -------------------------------------------------------

adminApp.get('/api/users', adminGuard, (c) => {
  const userInfo = listUsers().map(u => ({
    id: u.id,
    email: u.email,
    apiKey: u.api_key,
    rateLimitRpm: u.rate_limit_rpm || config.users.defaultRateLimitRpm,
    maxConcurrency: u.max_concurrency || config.users.defaultMaxConcurrency,
    activeStreams: getUserActiveStreams(u.id),
  }))
  return c.json(userInfo)
})

adminApp.post('/api/users', adminGuard, async (c) => {
  const body: any = await c.req.json().catch(() => null)
  const apiKey = String(body?.apiKey || '').trim()
  const id = String(body?.id || '').trim() || `user-${crypto.randomUUID().slice(0, 8)}`
  if (!apiKey) return c.json({ error: 'apiKey é obrigatório' }, 400)
  try {
    upsertUser({
      id,
      email: body?.email || id,
      apiKey,
      rateLimitRpm: Number(body?.rateLimitRpm) || config.users.defaultRateLimitRpm,
      maxConcurrency: Number(body?.maxConcurrency) || config.users.defaultMaxConcurrency,
    })
    return c.json({ ok: true, id })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

adminApp.put('/api/users/:id', adminGuard, async (c) => {
  const id = c.req.param('id')
  const body: any = await c.req.json().catch(() => null)
  if (!id) return c.json({ error: 'id é obrigatório' }, 400)
  try {
    const existing = getUserById(id)
    upsertUser({
      id,
      email: body?.email ?? existing?.email ?? id,
      apiKey: body?.apiKey ?? existing?.api_key,
      rateLimitRpm: Number(body?.rateLimitRpm) || config.users.defaultRateLimitRpm,
      maxConcurrency: Number(body?.maxConcurrency) || config.users.defaultMaxConcurrency,
    })
    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

adminApp.delete('/api/users/:id', adminGuard, (c) => {
  deleteUserById(c.req.param('id'))
  return c.json({ ok: true })
})

// --- Settings ---------------------------------------------------------------

adminApp.get('/api/settings', adminGuard, (c) => {
  const env = readEnvFile()
  const safe: Record<string, string> = {}
  const types: Record<string, string> = {}
  for (const key of SETTINGS_ALLOWLIST) {
    if (BOOLEAN_KEYS.has(key)) types[key] = 'bool'
    else if (INTEGER_KEYS.has(key)) types[key] = 'int'
    else types[key] = 'string'
  }
  for (const key of Object.keys(env)) {
    if (SETTINGS_ALLOWLIST.has(key)) safe[key] = env[key]
    else if (SETTINGS_SECRETS.has(key)) safe[key] = env[key] ? '••••••••' : ''
  }
  return c.json({
    settings: safe,
    types,
    allowlist: [...SETTINGS_ALLOWLIST],
    locked: [...SETTINGS_SECRETS],
    liveKeys: [...LIVE_KEYS],
    runtime: getLiveSettings(),
    effective: {
      warmPoolSize: config.warmPool.size,
      lanes: config.accounts.lanes,
      singleAccountMode: config.accounts.singleAccountMode,
      hybridVerify: config.hybridSessions.verify,
      userRateLimitRpm: config.users.defaultRateLimitRpm,
      userMaxConcurrency: config.users.defaultMaxConcurrency,
    },
  })
})

adminApp.post('/api/settings', adminGuard, async (c) => {
  const body: any = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'patch inválido' }, 400)
  try {
    // Split the patch: LIVE_KEYS apply immediately (no restart); the rest are
    // startup-only and still require a restart. Both are persisted to .env.
    const livePatch: Record<string, string | null> = {}
    const restartPatch: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(body)) {
      if (LIVE_KEYS.has(key)) livePatch[key] = value as string | null
      else restartPatch[key] = value as string | null
    }

    let liveApplied: string[] = []
    if (Object.keys(livePatch).length > 0) {
      const persisted = persistEnvPatch(livePatch)
      for (const key of persisted) {
        applyRuntimeSetting(key, livePatch[key] === null ? null : String(livePatch[key]))
      }
      liveApplied = persisted
    }

    const restartApplied = Object.keys(restartPatch).length > 0 ? persistEnvPatch(restartPatch) : []
    return c.json({
      ok: true,
      applied: [...liveApplied, ...restartApplied],
      live: liveApplied,
      restartRequired: restartApplied.length > 0,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

adminApp.post('/api/restart', adminGuard, (c) => {
  restartServer()
  return c.json({ ok: true, restarting: true })
})

// --- Raw Prometheus metrics -------------------------------------------------

adminApp.get('/api/metrics', adminGuard, (c) => {
  return c.text(metrics.formatPrometheus(), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } })
})

// --- Logs (SSE stream + buffer) ---------------------------------------------

adminApp.get('/api/logs', adminGuard, (c) => {
  const since = Number(c.req.query('since') || 0)
  const entries = since > 0 ? logBuffer.getSince(since) : logBuffer.getAll()
  return c.json(entries)
})

adminApp.post('/api/logs/clear', adminGuard, (c) => {
  logBuffer.clear()
  return c.json({ ok: true })
})

adminApp.get('/api/logs/live', adminGuard, (c) => {
  return streamSSE(c, async (stream) => {
    const listener = async (entry: any) => {
      try {
        await stream.writeSSE({ data: JSON.stringify(entry), event: 'log' })
      } catch { /* client gone */ }
    }
    logBuffer.addListener(listener)
    try {
      while (true) {
        await stream.sleep(5000)
        if (c.req.raw.signal.aborted || stream.closed) break
      }
    } catch { /* client disconnected */ }
    finally {
      logBuffer.removeListener(listener)
    }
  })
})

// --- Sessions ---------------------------------------------------------------

adminApp.get('/api/sessions', adminGuard, (c) => {
  const rows = listSessions()
  const now = Date.now()
  const ttlMs = config.hybridSessions.ttlMs
  return c.json(rows.map((r) => ({
    sessionKey: r.session_key,
    chatId: r.chat_id,
    accountId: r.account_id,
    parentId: r.parent_id,
    historyComplete: r.history_complete !== 0,
    updatedAt: r.updated_at,
    ttlRemaining: Math.max(0, ttlMs - (now - r.updated_at)),
  })))
})

adminApp.delete('/api/sessions/:key', adminGuard, (c) => {
  removeSession(c.req.param('key'))
  return c.json({ ok: true })
})

adminApp.post('/api/sessions/clear', adminGuard, (c) => {
  resetAllSessions()
  return c.json({ ok: true })
})

// --- Models -----------------------------------------------------------------

adminApp.get('/api/models', adminGuard, async (c) => {
  const usage = getModelUsage()
  const entries = Object.entries(usage).sort(([, a], [, b]) => b - a)
  const models = entries.map(([id, count]) => ({
    id,
    contextWindow: getModelContextWindow(id),
    requestCount: count,
  }))

  let catalog: any[] = []
  try {
    catalog = await fetchFullModelCatalog()
  } catch (err: any) {
    console.warn('Failed to load model catalog:', err?.message)
  }

  const usageMap = new Map(entries)
  const catalogWithUsage = catalog.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.context_window ?? getModelContextWindow(m.id),
    capabilities: m.capabilities,
    owned_by: m.owned_by,
    requestCount: usageMap.get(m.id) ?? 0,
  }))

  return c.json({ models, catalog: catalogWithUsage })
})

// --- Usage stats ------------------------------------------------------------

adminApp.get('/api/usage', adminGuard, (c) => {
  const topLimit = Number(c.req.query('limit') || 20)
  return c.json({
    users: getTopUsers(topLimit).map(u => {
      const users = listUsers()
      const user = users.find(usr => usr.id === u.userId)
      return { ...u, email: user?.email || u.userId }
    }),
    models: getModelUsage(),
  })
})

// --- Playground (test chat) -------------------------------------------------

adminApp.post('/api/test-chat', adminGuard, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'body required' }, 400)
  const stream = body.stream !== false
  const payload = {
    model: body.model || 'qwen-plus',
    messages: body.messages || [],
    stream,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
  }
  const apiKey = process.env.API_KEY || config.apiKey || 'sk-no-key'
  const res = await fetch(`http://127.0.0.1:${config.server.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })
  if (stream) {
    // Pass the upstream SSE body through RAW. Re-wrapping it with writeSSE
    // would nest "data: data: {...}" lines and the client's JSON.parse fails
    // (playground showed truncated/blank responses). Preserve the upstream
    // status so 429/5xx reach the client as errors, not "200 with SSE".
    if (!res.body) return c.json({ error: 'upstream returned empty body' }, 502)
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }
  const json = await res.json()
  return c.json(json)
})

// --- SPA (React + shadcn build) ---------------------------------------------

const WEB_DIST = path.resolve('web', 'dist')

// Dev mode (`npm run dev` passes --dev): redirect the SPA to the Vite dev server
// so the panel always shows the latest source with HMR instead of the last build.
const IS_WEB_DEV = process.argv.includes('--dev')
const WEB_DEV_BASE = process.env.QWEN_WEB_DEV_URL || 'http://localhost:5173'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function distFileSafe(rel: string): string | null {
  const resolved = path.normalize(path.join(WEB_DIST, rel))
  if (!resolved.startsWith(WEB_DIST + path.sep) && resolved !== WEB_DIST) return null
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
  } catch { /* ignore */ }
  return null
}

adminApp.get('/assets/*', (c) => {
  const rel = c.req.path.replace(/^\/admin\/?/, '')
  const file = distFileSafe(rel)
  if (!file) return c.notFound()
  const ext = path.extname(file).toLowerCase()
  return c.body(fs.readFileSync(file), 200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
})

adminApp.get('*', (c) => {
  // API-only paths should not fall through to the SPA.
  if (c.req.path.startsWith('/api')) return c.notFound()
  if (IS_WEB_DEV) {
    const rel = c.req.path.replace(/^\/admin\/?/, '')
    return c.redirect(`${WEB_DEV_BASE}/admin/${rel}`, 302)
  }
  const rel = c.req.path.replace(/^\/admin\/?/, '') || 'index.html'
  // Serve real files from the built app (index.html, public/ assets, etc.);
  // unknown paths fall back to index.html for SPA routing.
  const file = distFileSafe(rel) || distFileSafe('index.html')
  if (!file) {
    return c.html(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QwenProxy · Admin</title></head>` +
      `<body style="font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0e0a;color:#d8e0c8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">` +
      `<div style="max-width:520px;border:1px solid #333;padding:28px;background:#11150f"><p style="color:#c8f542;font-size:18px;margin:0 0 10px">Dashboard não compilado</p>` +
      `<p style="font-size:13px;line-height:1.6">O painel React não foi construído. Execute na raiz do projeto:</p>` +
      `<pre style="background:#0e120b;border:1px solid #333;padding:12px;font-size:12px">npm --prefix web install
npm run build:admin</pre>` +
      `<p style="font-size:12px;color:#8b957d">Depois recarregue esta página.</p></div></body></html>`,
      200,
      { 'Content-Type': 'text/html; charset=utf-8' },
    )
  }
  const ext = path.extname(file).toLowerCase()
  if (ext === '.html' || rel === 'index.html') {
    return c.html(fs.readFileSync(file, 'utf-8'))
  }
  return c.body(fs.readFileSync(file), 200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
})
