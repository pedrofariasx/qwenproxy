import { z } from 'zod'

const envInt = (def: number, min = 0) =>
  z.string().default(String(def)).transform(v => {
    const n = Number(v)
    if (!Number.isInteger(n)) throw new Error(`Expected integer, got "${v}"`)
    if (n < min) throw new Error(`Expected >= ${min}, got ${n}`)
    return n
  })

const envBool = (defaultTrue: boolean) =>
  z.string().default(defaultTrue ? 'true' : 'false').transform(v =>
    defaultTrue ? v !== 'false' : v === 'true'
  )

const envSchema = z.object({
  PORT: envInt(3000, 1),
  HOST: z.string().default('0.0.0.0'),
  HEADLESS: envBool(true),
  BROWSER: z.enum(['chromium', 'firefox', 'webkit', 'chrome', 'edge']).default('chromium'),
  USER_DATA_DIR: z.string().default('./qwen_profiles'),
  USER_AGENT: z.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'),
  LOG_CONSOLE: envBool(false),
  BROWSER_IDLE_HIBERNATE_MS: envInt(300000, 0),
  NAVIGATION_TIMEOUT: envInt(90000, 1),
  PAGE_TIMEOUT: envInt(60000, 1),
  HTTP_TIMEOUT: envInt(45000, 1),
  HEADERS_TIMEOUT: envInt(90000, 1),
  CHAT_TIMEOUT: envInt(120000, 1),
  STREAM_IDLE_TIMEOUT: envInt(180000, 1),
  CACHE_TTL: envInt(3600, 1),
  RESPONSE_TTL: envInt(1800, 1),
  METRICS_INTERVAL: envInt(10000, 1),
  WATCHDOG_INTERVAL: envInt(5000, 1),
  WATCHDOG_FAILURES: envInt(3, 1),
  RAM_WARNING: envInt(70, 1),
  RAM_CRITICAL: envInt(90, 1),
  WS_WARNING: envInt(40, 1),
  WS_CRITICAL: envInt(80, 1),
  QWEN_BASE_URL: z.string().default('https://chat.qwen.ai'),
  QWEN_HTTP_ENDPOINT: z.string().default('https://api.qwen.ai/v1/chat'),
  QWEN_API_KEY: z.string().default(''),
  API_KEY: z.string().default(''),
  HEADERS_TTL_MS: envInt(1800000, 1),
  BACKGROUND_HEADER_REFRESH: envBool(true),
  WARM_POOL_SIZE: envInt(3),
  WARM_POOL_LOW_WATER: envInt(1),
  WARM_POOL_TTL_MS: envInt(600000, 1),
  WARM_POOL_STARTUP: envBool(true),
  SESSION_KEEPER_ENABLED: envBool(true),
  ACCOUNT_INIT_CONCURRENCY: envInt(1, 1),
  ACCOUNT_INIT_STAGGER_MIN_MS: envInt(250),
  ACCOUNT_INIT_STAGGER_MAX_MS: envInt(800),
  PRECAPTURE_HEADERS_STARTUP: envBool(true),
  PRECAPTURE_HEADERS_CONCURRENCY: envInt(1, 1),
  PRECAPTURE_HEADERS_STAGGER_MIN_MS: envInt(2500),
  PRECAPTURE_HEADERS_STAGGER_MAX_MS: envInt(5000),
  SINGLE_ACCOUNT_MODE: envBool(false),
  SINGLE_ACCOUNT_ID: z.string().default(''),
  SINGLE_ACCOUNT_EMAIL: z.string().default(''),
  ACCOUNT_LANES: envInt(1, 1),
  ACCOUNT_MAX_CONCURRENT_STREAMS: envInt(2, 1),
  ACCOUNT_STREAM_SLOT_WAIT_MS: envInt(30000, 1000),
  QWEN_DIRECT_FETCH: envBool(true),
  LARGE_PROMPT_THRESHOLD: envInt(524288, 1),
  LARGE_PROMPT_INLINE: envBool(false),
  LARGE_PROMPT_UPLOAD_CACHE_TTL_MS: envInt(1800000, 0),
  HYBRID_SESSIONS_ENABLED: envBool(true),
  HYBRID_SESSION_VERIFY: envBool(true),
  HYBRID_SESSION_VERIFY_EVERY_MS: envInt(60000, 0),
  HYBRID_SESSION_TTL_MS: envInt(86400000, 1),
  STREAM_DEGENERATE_GUARD: z.enum(['prone', 'always', 'off']).default('always'),
  AUTO_CONTINUE: envBool(true),
  MAX_AUTO_CONTINUES: envInt(3, 1),
  AUTH_REQUIRED: envBool(false),
  USER_RATE_LIMIT_RPM: envInt(120, 0),
  USER_MAX_CONCURRENCY: envInt(8, 1),
  USER_API_KEYS: z.string().default(''),
  ADMIN_PASSWORD: z.string().default(''),
})

const env = envSchema.parse(process.env)

export const config = {
  server: {
    port: env.PORT,
    host: env.HOST,
  },
  browser: {
    headless: env.HEADLESS,
    type: env.BROWSER,
    userDataDir: env.USER_DATA_DIR,
    userAgent: env.USER_AGENT,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    launchTimeout: 30000,
    healthCheckInterval: 30000,
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    logConsole: env.LOG_CONSOLE,
    idleHibernateMs: env.BROWSER_IDLE_HIBERNATE_MS,
  },
  timeouts: {
    navigation: env.NAVIGATION_TIMEOUT,
    page: env.PAGE_TIMEOUT,
    http: env.HTTP_TIMEOUT,
    headers: env.HEADERS_TIMEOUT,
    chat: env.CHAT_TIMEOUT,
    streamIdle: env.STREAM_IDLE_TIMEOUT,
  },
  cache: {
    defaultTTL: env.CACHE_TTL,
    responseTTL: env.RESPONSE_TTL,
  },
  metrics: {
    interval: env.METRICS_INTERVAL,
  },
  watchdog: {
    checkInterval: env.WATCHDOG_INTERVAL,
    consecutiveFailuresThreshold: env.WATCHDOG_FAILURES,
    ram: {
      warningThreshold: env.RAM_WARNING,
      criticalThreshold: env.RAM_CRITICAL,
    },
    streams: {
      warningThreshold: env.WS_WARNING,
      criticalThreshold: env.WS_CRITICAL,
    },
  },
  apiKey: env.API_KEY,
  qwen: {
    baseUrl: env.QWEN_BASE_URL,
    httpEndpoint: env.QWEN_HTTP_ENDPOINT,
    apiKey: env.QWEN_API_KEY,
  },
  headers: {
    ttlMs: env.HEADERS_TTL_MS,
    backgroundRefresh: env.BACKGROUND_HEADER_REFRESH,
  },
  warmPool: {
    size: env.WARM_POOL_SIZE,
    lowWater: env.WARM_POOL_LOW_WATER,
    ttlMs: env.WARM_POOL_TTL_MS,
    startup: env.WARM_POOL_STARTUP,
  },
  sessionKeeper: {
    enabled: env.SESSION_KEEPER_ENABLED,
  },
  accounts: {
    initConcurrency: env.ACCOUNT_INIT_CONCURRENCY,
    initStaggerMinMs: env.ACCOUNT_INIT_STAGGER_MIN_MS,
    initStaggerMaxMs: env.ACCOUNT_INIT_STAGGER_MAX_MS,
    singleAccountMode: env.SINGLE_ACCOUNT_MODE,
    singleAccountId: env.SINGLE_ACCOUNT_ID,
    singleAccountEmail: env.SINGLE_ACCOUNT_EMAIL,
    lanes: env.ACCOUNT_LANES,
    maxStreamsPerAccount: env.ACCOUNT_MAX_CONCURRENT_STREAMS,
    streamSlotWaitMs: env.ACCOUNT_STREAM_SLOT_WAIT_MS,
  },
  directFetch: {
    enabled: env.QWEN_DIRECT_FETCH,
  },
  precapture: {
    headersStartup: env.PRECAPTURE_HEADERS_STARTUP,
    concurrency: env.PRECAPTURE_HEADERS_CONCURRENCY,
    staggerMinMs: env.PRECAPTURE_HEADERS_STAGGER_MIN_MS,
    staggerMaxMs: env.PRECAPTURE_HEADERS_STAGGER_MAX_MS,
  },
  largePromptThreshold: env.LARGE_PROMPT_THRESHOLD,
  largePromptInline: env.LARGE_PROMPT_INLINE,
  largePromptUploadCacheTtlMs: env.LARGE_PROMPT_UPLOAD_CACHE_TTL_MS,
  hybridSessions: {
    enabled: env.HYBRID_SESSIONS_ENABLED,
    verify: env.HYBRID_SESSION_VERIFY,
    verifyEveryMs: env.HYBRID_SESSION_VERIFY_EVERY_MS,
    ttlMs: env.HYBRID_SESSION_TTL_MS,
  },
  streamDegenerateGuard: env.STREAM_DEGENERATE_GUARD,
  autoContinue: {
    enabled: env.AUTO_CONTINUE,
    maxContinues: env.MAX_AUTO_CONTINUES,
  },
  authRequired: env.AUTH_REQUIRED,
  users: {
    defaultRateLimitRpm: env.USER_RATE_LIMIT_RPM,
    defaultMaxConcurrency: env.USER_MAX_CONCURRENCY,
    apiKeys: env.USER_API_KEYS,
  },
  adminPassword: env.ADMIN_PASSWORD,
}

export type Config = typeof config
