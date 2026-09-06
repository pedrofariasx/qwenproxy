import i18next from 'i18next'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    throw new ApiError(res.status, json?.error || i18next.t('api.httpError', { status: res.status }))
  }
  return json as T
}

export interface Account {
  id: string
  email: string
  cooldown: number
  cooldownReason: string | null
  activeLoad: number
  ready?: boolean
  streams?: number
}

export interface SeriesPoint {
  t: number
  v: number
}

export interface Overview {
  uptime: number
  requestsTotal: number
  requestsCompletions: number
  requestsErrors: number
  requests4xx?: number
  requests5xx?: number
  requestsSuccessRate: number
  latency?: { sum: number; count: number }
  latencyCompletion?: { sum: number; count: number }
  memory: {
    rss: number
    heapUsed: number
    heapTotal: number
    systemTotal: number
    pct: number
  }
  cpu?: { cores: number; load1m: number }
  accounts: Account[]
  inUseAccounts: string[]
  users: { id: string; email: string | null; streams: number }[]
  totalUserStreams: number
  warmPool: Record<string, number>
  sessionCount: number
  activeStreamsMetric: number
  lanes: number
  maxStreamsPerAccount?: number
  readyAccountCount?: number
  series?: Record<string, SeriesPoint[]>
  userRateLimitRpm: number
  userMaxConcurrency: number
  watchdog?: { overall: number; ram: number }
}

export interface AdminUser {
  id: string
  email: string | null
  apiKey: string
  rateLimitRpm: number
  maxConcurrency: number
  activeStreams: number
}

export interface SettingsData {
  settings: Record<string, string>
  types: Record<string, string>
  allowlist: string[]
  effective: Record<string, number | boolean>
  liveKeys?: string[]
  runtime?: Record<string, string>
}

export interface LogEntry {
  id: number
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  context?: string
  data?: Record<string, unknown>
}

export interface SessionInfo {
  sessionKey: string
  chatId: string
  accountId: string
  parentId: string | null
  historyComplete: boolean
  updatedAt: number
  ttlRemaining: number
}

export interface ActiveStream {
  key: string
  accountId: string
  uiSessionId: string
  targetResponseId: string
  createdAt: number
  ageMs: number
}

export interface ModelInfo {
  id: string
  contextWindow: number
  requestCount: number
}

export interface FingerprintProfile {
  accountId: string
  userAgent: string
  appVersion: string
  chromeVersion: string
  chromeMajor: number
  platform: string
  platformVersion: string
  architecture: string
  bitness: string
  viewport: { width: number; height: number }
  hardwareConcurrency: number
  deviceMemory: number
  languages: string[]
  webglVendor: string
  webglRenderer: string
  colorDepth: number
  pixelDepth: number
  canvasNoiseSeed: number
  audioNoiseSeed: number
  webglNoiseSeed: number
  outerWidthOffset: number
  outerHeightOffset: number
}

export interface AccountFingerprint {
  accountId: string
  salt: number
  resourceVersion: number
  profile: FingerprintProfile
  lanes?: Array<{ lane: number; id: string; profile: FingerprintProfile }>
}

export interface PersonalizationConfig {
  name: string
  description: string
  style: string
  instruction: string
}

export interface PersonalizationApplyResult {
  accountId: string
  email?: string
  ok: boolean
  status?: number
  error?: string
}

export interface CatalogModel {
  id: string
  name?: string
  contextWindow?: number
  capabilities?: string[]
  owned_by?: string
  requestCount: number
}

export interface ModelsData {
  models: ModelInfo[]
  catalog: CatalogModel[]
}

export interface UsageUser {
  userId: string
  email: string
  requestCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  lastRequestAt: number
}

export interface UsageData {
  users: UsageUser[]
  models: Record<string, number>
}

export const api = {
  overview: () => request<Overview>('/overview'),
  accounts: () => request<{ accounts: Account[]; inUse: string[]; maxStreamsPerAccount?: number }>('/accounts'),
  addAccount: (email: string, password: string) => request('/accounts', { method: 'POST', body: JSON.stringify({ email, password }) }),
  removeAccount: (id: string) => request(`/accounts/${id}`, { method: 'DELETE' }),
  clearCooldown: (id: string) => request(`/accounts/${id}/clear-cooldown`, { method: 'POST' }),
  refreshHeaders: (id: string) => request(`/accounts/${id}/refresh`, { method: 'POST' }),
  accountFingerprint: (id: string) => request<AccountFingerprint>(`/accounts/${id}/fingerprint`),
  personalization: () => request<PersonalizationConfig>('/personalization'),
  savePersonalization: (cfg: PersonalizationConfig) => request<{ ok: boolean; config: PersonalizationConfig }>('/personalization', { method: 'POST', body: JSON.stringify(cfg) }),
  applyPersonalization: (accountId?: string) => request<{ ok: boolean; applied: number; succeeded: number; failed: number; results: PersonalizationApplyResult[] }>('/personalization/apply', { method: 'POST', body: JSON.stringify({ accountId }) }),
  users: () => request<AdminUser[]>('/users'),
  createUser: (u: { email?: string; apiKey: string; rateLimitRpm: number; maxConcurrency: number }) => request('/users', { method: 'POST', body: JSON.stringify(u) }),
  updateUser: (id: string, u: Partial<{ email: string; apiKey: string; rateLimitRpm: number; maxConcurrency: number }>) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(u) }),
  deleteUser: (id: string) => request(`/users/${id}`, { method: 'DELETE' }),
  settings: () => request<SettingsData>('/settings'),
  saveSettings: (patch: Record<string, string>) => request<{ ok: boolean; applied: string[]; live: string[]; restartRequired: boolean }>('/settings', { method: 'POST', body: JSON.stringify(patch) }),
  metrics: async (): Promise<string> => {
    const res = await fetch('/admin/api/metrics')
    if (!res.ok) throw new ApiError(res.status, i18next.t('api.metricsFetchFailed'))
    return res.text()
  },
  logs: (since?: number) => request<LogEntry[]>(`/logs${since ? `?since=${since}` : ''}`),
  clearLogs: () => request('/logs/clear', { method: 'POST' }),
  sessions: () => request<SessionInfo[]>('/sessions'),
  deleteSession: (key: string) => request(`/sessions/${key}`, { method: 'DELETE' }),
  clearSessions: () => request('/sessions/clear', { method: 'POST' }),
  streams: () => request<{ streams: ActiveStream[] }>('/streams'),
  stopStream: (key: string) => request<{ ok: boolean }>(`/streams/${encodeURIComponent(key)}/stop`, { method: 'POST' }),
  clearCooldowns: () => request<{ ok: boolean; cleared: number }>('/clear-cooldowns', { method: 'POST' }),
  exportMetrics: async (): Promise<string> => {
    const res = await fetch('/admin/api/metrics/export')
    if (!res.ok) throw new ApiError(res.status, i18next.t('api.exportMetricsFailed'))
    return res.text()
  },
  models: () => request<ModelsData>('/models'),
  usage: (limit?: number) => request<UsageData>(`/usage${limit ? `?limit=${limit}` : ''}`),
  testChat: async (payload: { model: string; messages: Array<{ role: string; content: string }>; stream: boolean; thinking?: { type: string } }): Promise<Response> => {
    return fetch('/admin/api/test-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  },
}

export function genKey(): string {
  const rand = (n: number) => Math.random().toString(36).slice(2, 2 + n)
  return `sk-${rand(10)}${rand(10)}`
}

export function fmtBytes(n?: number): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export function fmtSec(s?: number): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}