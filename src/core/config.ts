import { z } from 'zod'

const envSchema = z.object({
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),
  HEADLESS: z.string().default('true'),
  USER_DATA_DIR: z.string().default('./qwen_profile'),
  USER_AGENT: z.string().default('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
  LOG_CONSOLE: z.string().default('false'),
  NAVIGATION_TIMEOUT: z.string().default('30000'),
  PAGE_TIMEOUT: z.string().default('15000'),
  HTTP_TIMEOUT: z.string().default('10000'),
  CHAT_TIMEOUT: z.string().default('120000'),
  CACHE_TTL: z.string().default('3600'),
  RESPONSE_TTL: z.string().default('1800'),
  METRICS_INTERVAL: z.string().default('10000'),
  WATCHDOG_INTERVAL: z.string().default('5000'),
  WATCHDOG_FAILURES: z.string().default('3'),
  RAM_WARNING: z.string().default('80'),
  RAM_CRITICAL: z.string().default('95'),
  WS_WARNING: z.string().default('50'),
  WS_CRITICAL: z.string().default('100'),
  QWEN_BASE_URL: z.string().default('https://chat.qwen.ai'),
  QWEN_HTTP_ENDPOINT: z.string().default('https://api.qwen.ai/v1/chat'),
  QWEN_API_KEY: z.string().default(''),
  QWEN_EMAIL: z.string().default(''),
  QWEN_PASSWORD: z.string().default(''),
  API_KEY: z.string().default(''),
  SHUTDOWN_TIMEOUT_MS: z.string().default('10000'),
  CACHE_MAX_ENTRIES: z.string().default('10000'),
  RATE_LIMIT_ENABLED: z.string().default('false'),
  RATE_LIMIT_MAX: z.string().default('60'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000'),
  RATE_LIMIT_HEADER: z.string().default('x-forwarded-for'),
  EXECUTOR_ENABLED: z.string().default('false'),
  EXECUTOR_MAX_TURNS: z.string().default('10'),
  EXECUTOR_TIMEOUT_MS: z.string().default('120000'),
})

const env = envSchema.parse(process.env)

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
  },
  browser: {
    headless: env.HEADLESS !== 'false',
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
    logConsole: env.LOG_CONSOLE === 'true',
  },
  timeouts: {
    navigation: parseInt(env.NAVIGATION_TIMEOUT),
    page: parseInt(env.PAGE_TIMEOUT),
    http: parseInt(env.HTTP_TIMEOUT),
    chat: parseInt(env.CHAT_TIMEOUT),
  },
  cache: {
    defaultTTL: parseInt(env.CACHE_TTL),
    responseTTL: parseInt(env.RESPONSE_TTL),
    maxEntries: parseInt(env.CACHE_MAX_ENTRIES),
  },
  shutdown: {
    timeoutMs: parseInt(env.SHUTDOWN_TIMEOUT_MS),
  },
  metrics: {
    interval: parseInt(env.METRICS_INTERVAL),
  },
  watchdog: {
    checkInterval: parseInt(env.WATCHDOG_INTERVAL),
    consecutiveFailuresThreshold: parseInt(env.WATCHDOG_FAILURES),
    ram: {
      warningThreshold: parseInt(env.RAM_WARNING),
      criticalThreshold: parseInt(env.RAM_CRITICAL),
    },
    websocket: {
      warningThreshold: parseInt(env.WS_WARNING),
      criticalThreshold: parseInt(env.WS_CRITICAL),
    },
  },
  apiKey: env.API_KEY,
  validation: {
    MAX_MESSAGES: 200,
    MAX_REQUEST_BODY_BYTES: 10485760,
  },
  rateLimiter: {
    enabled: env.RATE_LIMIT_ENABLED === 'true',
    max: parseInt(env.RATE_LIMIT_MAX),
    windowMs: parseInt(env.RATE_LIMIT_WINDOW_MS),
    headerKey: env.RATE_LIMIT_HEADER,
  },
  executor: {
    enabled: env.EXECUTOR_ENABLED === 'true',
    maxTurns: parseInt(env.EXECUTOR_MAX_TURNS),
    timeoutMs: parseInt(env.EXECUTOR_TIMEOUT_MS),
  },
  qwen: {
    baseUrl: env.QWEN_BASE_URL,
    httpEndpoint: env.QWEN_HTTP_ENDPOINT,
    apiKey: env.QWEN_API_KEY,
    email: env.QWEN_EMAIL,
    password: env.QWEN_PASSWORD,
  },
}

export type Config = typeof config
