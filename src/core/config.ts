import { z } from 'zod'

export interface ConfigEnvSpec {
  name: string
  defaultValue: string
  aliases?: string[]
  legacy?: boolean
}

const resolveEnv = (name: string, defaultValue: string, aliases: string[] = []): string => {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      return value
    }
  }
  return defaultValue
}

const rawEnv = {
  PORT: resolveEnv('PORT', '3000'),
  HOST: resolveEnv('HOST', '0.0.0.0'),
  NODE_ENV: resolveEnv('NODE_ENV', 'development'),
  API_KEY: resolveEnv('API_KEY', ''),
  SSL_ENABLED: resolveEnv('SSL_ENABLED', 'false'),
  SSL_CERT_PATH: resolveEnv('SSL_CERT_PATH', ''),
  SSL_KEY_PATH: resolveEnv('SSL_KEY_PATH', ''),
  BROWSER_HEADLESS: resolveEnv('BROWSER_HEADLESS', 'true', ['HEADLESS']),
  BROWSER: resolveEnv('BROWSER', 'chromium'),
  BROWSER_EXECUTABLE_PATH: resolveEnv('BROWSER_EXECUTABLE_PATH', ''),
  QWEN_PROFILES_PATH: resolveEnv('QWEN_PROFILES_PATH', './qwen_profile', ['USER_DATA_DIR']),
  USER_AGENT: resolveEnv(
    'USER_AGENT',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ),
  NAVIGATION_TIMEOUT: resolveEnv('NAVIGATION_TIMEOUT', '30000'),
  PAGE_TIMEOUT: resolveEnv('PAGE_TIMEOUT', '15000'),
  HTTP_TIMEOUT: resolveEnv('HTTP_TIMEOUT', '10000'),
  CHAT_TIMEOUT: resolveEnv('CHAT_TIMEOUT', '120000'),
  CACHE_TTL: resolveEnv('CACHE_TTL', '3600', ['CACHE_TTL_MS']),
  RESPONSE_TTL: resolveEnv('RESPONSE_TTL', '1800'),
  CACHE_MAX_ENTRIES: resolveEnv('CACHE_MAX_ENTRIES', '10000'),
  METRICS_INTERVAL: resolveEnv('METRICS_INTERVAL', '10000'),
  WATCHDOG_INTERVAL: resolveEnv('WATCHDOG_INTERVAL', '5000', ['WATCHDOG_INTERVAL_MS']),
  WATCHDOG_FAILURES: resolveEnv('WATCHDOG_FAILURES', '3'),
  RAM_WARNING: resolveEnv('RAM_WARNING', '512'),
  RAM_CRITICAL: resolveEnv('RAM_CRITICAL', '1024'),
  WS_WARNING: resolveEnv('WS_WARNING', '50'),
  WS_CRITICAL: resolveEnv('WS_CRITICAL', '100'),
  SHUTDOWN_TIMEOUT_MS: resolveEnv('SHUTDOWN_TIMEOUT_MS', '10000'),
  RATE_LIMIT_ENABLED: resolveEnv('RATE_LIMIT_ENABLED', 'false'),
  RATE_LIMIT_MAX: resolveEnv('RATE_LIMIT_MAX', '60'),
  RATE_LIMIT_WINDOW_MS: resolveEnv('RATE_LIMIT_WINDOW_MS', '60000'),
  RATE_LIMIT_HEADER: resolveEnv('RATE_LIMIT_HEADER', 'x-forwarded-for'),
  EXECUTOR_ENABLED: resolveEnv('EXECUTOR_ENABLED', 'false'),
  EXECUTOR_MAX_TURNS: resolveEnv('EXECUTOR_MAX_TURNS', '10'),
  EXECUTOR_TIMEOUT_MS: resolveEnv('EXECUTOR_TIMEOUT_MS', '120000'),
  TOOL_TIMEOUT_MS: resolveEnv('TOOL_TIMEOUT_MS', '30000'),
  TOOL_MAX_ARGUMENTS_BYTES: resolveEnv('TOOL_MAX_ARGUMENTS_BYTES', '1048576'),
  TOOL_MAX_RESULT_BYTES: resolveEnv('TOOL_MAX_RESULT_BYTES', '524288'),
  TOOL_MAX_CALLS: resolveEnv('TOOL_MAX_CALLS', '20'),
  LOG_FORMAT: resolveEnv('LOG_FORMAT', 'text'),
  LOG_CONSOLE: resolveEnv('LOG_CONSOLE', 'false'),
  QWEN_BASE_URL: resolveEnv('QWEN_BASE_URL', 'https://chat.qwen.ai'),
  QWEN_HTTP_ENDPOINT: resolveEnv('QWEN_HTTP_ENDPOINT', 'https://api.qwen.ai/v1/chat'),
  QWEN_EMAIL: resolveEnv('QWEN_EMAIL', ''),
  QWEN_PASSWORD: resolveEnv('QWEN_PASSWORD', ''),
  QWEN_ENCRYPTION_KEY: resolveEnv('QWEN_ENCRYPTION_KEY', ''),
} as const

const envSchema = z.object({
  PORT: z.string(),
  HOST: z.string(),
  NODE_ENV: z.string(),
  API_KEY: z.string(),
  SSL_ENABLED: z.string(),
  SSL_CERT_PATH: z.string(),
  SSL_KEY_PATH: z.string(),
  BROWSER_HEADLESS: z.string(),
  BROWSER: z.string(),
  BROWSER_EXECUTABLE_PATH: z.string(),
  QWEN_PROFILES_PATH: z.string(),
  USER_AGENT: z.string(),
  NAVIGATION_TIMEOUT: z.string(),
  PAGE_TIMEOUT: z.string(),
  HTTP_TIMEOUT: z.string(),
  CHAT_TIMEOUT: z.string(),
  CACHE_TTL: z.string(),
  RESPONSE_TTL: z.string(),
  CACHE_MAX_ENTRIES: z.string(),
  METRICS_INTERVAL: z.string(),
  WATCHDOG_INTERVAL: z.string(),
  WATCHDOG_FAILURES: z.string(),
  RAM_WARNING: z.string(),
  RAM_CRITICAL: z.string(),
  WS_WARNING: z.string(),
  WS_CRITICAL: z.string(),
  SHUTDOWN_TIMEOUT_MS: z.string(),
  RATE_LIMIT_ENABLED: z.string(),
  RATE_LIMIT_MAX: z.string(),
  RATE_LIMIT_WINDOW_MS: z.string(),
  RATE_LIMIT_HEADER: z.string(),
  EXECUTOR_ENABLED: z.string(),
  EXECUTOR_MAX_TURNS: z.string(),
  EXECUTOR_TIMEOUT_MS: z.string(),
  TOOL_TIMEOUT_MS: z.string(),
  TOOL_MAX_ARGUMENTS_BYTES: z.string(),
  TOOL_MAX_RESULT_BYTES: z.string(),
  TOOL_MAX_CALLS: z.string(),
  LOG_FORMAT: z.enum(['text', 'json']),
  LOG_CONSOLE: z.string(),
  QWEN_BASE_URL: z.string(),
  QWEN_HTTP_ENDPOINT: z.string(),
  QWEN_EMAIL: z.string(),
  QWEN_PASSWORD: z.string(),
  QWEN_ENCRYPTION_KEY: z.string(),
})

const env = envSchema.parse(rawEnv)

export const configEnvContract: ConfigEnvSpec[] = [
  { name: 'PORT', defaultValue: '3000' },
  { name: 'HOST', defaultValue: '0.0.0.0' },
  { name: 'NODE_ENV', defaultValue: 'development' },
  { name: 'API_KEY', defaultValue: '' },
  { name: 'SSL_ENABLED', defaultValue: 'false' },
  { name: 'SSL_CERT_PATH', defaultValue: '' },
  { name: 'SSL_KEY_PATH', defaultValue: '' },
  { name: 'BROWSER_HEADLESS', defaultValue: 'true', aliases: ['HEADLESS'] },
  { name: 'BROWSER', defaultValue: 'chromium' },
  { name: 'BROWSER_EXECUTABLE_PATH', defaultValue: '' },
  { name: 'QWEN_PROFILES_PATH', defaultValue: './qwen_profile', aliases: ['USER_DATA_DIR'] },
  { name: 'USER_AGENT', defaultValue: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  { name: 'NAVIGATION_TIMEOUT', defaultValue: '30000' },
  { name: 'PAGE_TIMEOUT', defaultValue: '15000' },
  { name: 'HTTP_TIMEOUT', defaultValue: '10000' },
  { name: 'CHAT_TIMEOUT', defaultValue: '120000' },
  { name: 'CACHE_TTL', defaultValue: '3600', aliases: ['CACHE_TTL_MS'] },
  { name: 'RESPONSE_TTL', defaultValue: '1800' },
  { name: 'CACHE_MAX_ENTRIES', defaultValue: '10000' },
  { name: 'METRICS_INTERVAL', defaultValue: '10000' },
  { name: 'WATCHDOG_INTERVAL', defaultValue: '5000', aliases: ['WATCHDOG_INTERVAL_MS'] },
  { name: 'WATCHDOG_FAILURES', defaultValue: '3' },
  { name: 'RAM_WARNING', defaultValue: '512' },    // RSS in MB
  { name: 'RAM_CRITICAL', defaultValue: '1024' },   // RSS in MB
  { name: 'WS_WARNING', defaultValue: '50' },
  { name: 'WS_CRITICAL', defaultValue: '100' },
  { name: 'SHUTDOWN_TIMEOUT_MS', defaultValue: '10000' },
  { name: 'RATE_LIMIT_ENABLED', defaultValue: 'false' },
  { name: 'RATE_LIMIT_MAX', defaultValue: '60' },
  { name: 'RATE_LIMIT_WINDOW_MS', defaultValue: '60000' },
  { name: 'RATE_LIMIT_HEADER', defaultValue: 'x-forwarded-for' },
  { name: 'EXECUTOR_ENABLED', defaultValue: 'false' },
  { name: 'EXECUTOR_MAX_TURNS', defaultValue: '10' },
  { name: 'EXECUTOR_TIMEOUT_MS', defaultValue: '120000' },
  { name: 'TOOL_TIMEOUT_MS', defaultValue: '30000' },
  { name: 'TOOL_MAX_ARGUMENTS_BYTES', defaultValue: '1048576' },
  { name: 'TOOL_MAX_RESULT_BYTES', defaultValue: '524288' },
  { name: 'TOOL_MAX_CALLS', defaultValue: '20' },
  { name: 'LOG_FORMAT', defaultValue: 'text' },
  { name: 'LOG_CONSOLE', defaultValue: 'false' },
  { name: 'QWEN_BASE_URL', defaultValue: 'https://chat.qwen.ai' },
  { name: 'QWEN_HTTP_ENDPOINT', defaultValue: 'https://api.qwen.ai/v1/chat' },
  { name: 'QWEN_EMAIL', defaultValue: '' },
  { name: 'QWEN_PASSWORD', defaultValue: '' },
  { name: 'QWEN_ENCRYPTION_KEY', defaultValue: '' },
]

export const legacyConfigEnvContract: ConfigEnvSpec[] = [
  { name: 'HEADLESS', defaultValue: 'true', legacy: true },
  { name: 'USER_DATA_DIR', defaultValue: './qwen_profile', legacy: true },
  { name: 'CACHE_TTL_MS', defaultValue: '3600', legacy: true },
  { name: 'WATCHDOG_INTERVAL_MS', defaultValue: '5000', legacy: true },
  { name: 'LOG_LEVEL', defaultValue: 'info', legacy: true },
  { name: 'REQUEST_TIMEOUT_MS', defaultValue: '120000', legacy: true },
  { name: 'METRICS_PREFIX', defaultValue: 'qwenproxy', legacy: true },
  { name: 'METRICS_PORT', defaultValue: '0', legacy: true },
  { name: 'WATCHDOG_MEMORY_LIMIT_MB', defaultValue: '-1', legacy: true },
  { name: 'QWEN_API_KEY', defaultValue: '', legacy: true },
]

export const config = {
  server: {
    port: parseInt(env.PORT),
    host: env.HOST,
  },
  ssl: {
    enabled: env.SSL_ENABLED === 'true',
    certPath: env.SSL_CERT_PATH,
    keyPath: env.SSL_KEY_PATH,
  },
  browser: {
    headless: env.BROWSER_HEADLESS !== 'false',
    type: env.BROWSER,
    executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
    userDataDir: env.QWEN_PROFILES_PATH,
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
    toolTimeoutMs: parseInt(env.TOOL_TIMEOUT_MS),
    maxArgumentBytes: parseInt(env.TOOL_MAX_ARGUMENTS_BYTES),
    maxResultBytes: parseInt(env.TOOL_MAX_RESULT_BYTES),
    maxToolCalls: parseInt(env.TOOL_MAX_CALLS),
  },
  qwen: {
    baseUrl: env.QWEN_BASE_URL,
    httpEndpoint: env.QWEN_HTTP_ENDPOINT,
    email: env.QWEN_EMAIL,
    password: env.QWEN_PASSWORD,
    encryptionKey: env.QWEN_ENCRYPTION_KEY,
  },
  logFormat: env.LOG_FORMAT,
}

export type Config = typeof config
