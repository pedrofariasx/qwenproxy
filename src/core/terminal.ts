type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'
type PaintStyle = LogLevel | 'dim' | 'bold' | 'cyan' | 'blue' | 'green' | 'yellow' | 'red' | 'magenta'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const COLORS: Record<PaintStyle, string> = {
  debug: '\x1b[36m',
  info: '\x1b[34m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  dim: DIM,
  bold: BOLD,
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
}
const SCOPE_COLORS: PaintStyle[] = ['cyan', 'blue', 'green', 'yellow', 'magenta']

function colorsEnabled(): boolean {
  return process.env.NO_COLOR !== '1'
    && process.env.NO_COLOR !== 'true'
    && process.env.TERM !== 'dumb'
}

export function paint(value: string, level: PaintStyle = 'info'): string {
  if (!colorsEnabled()) return value
  if (level === 'bold') return `${BOLD}${value}${RESET}`
  return `${COLORS[level]}${value}${RESET}`
}

export function maskSensitive(value: string): string {
  return value.replace(/\b([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (_match, prefix) => {
    return `${prefix}***`
  })
}

function now(): string {
  return new Date().toISOString().slice(11, 19)
}

function formatScope(scope: string): string {
  const color = SCOPE_COLORS[hash(scope) % SCOPE_COLORS.length]
  return `${paint(scope.padEnd(10).slice(0, 10), color)}`
}

function write(level: LogLevel, scope: string, message: string, details?: Array<string | null | undefined>): void {
  const marker = {
    debug: 'DBG',
    info: 'INF',
    success: 'OK ',
    warn: 'WRN',
    error: 'ERR',
  }[level]

  const line = `${paint(now(), 'dim')} ${paint(marker, level)} ${formatScope(scope)} ${maskSensitive(message)}`
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  out(line)

  for (const detail of details || []) {
    if (!detail) continue
    out(`  ${paint('|', 'dim')} ${maskSensitive(detail)}`)
  }
}

function hash(value: string): number {
  let result = 0
  for (let i = 0; i < value.length; i++) {
    result = ((result << 5) - result + value.charCodeAt(i)) | 0
  }
  return Math.abs(result)
}

export const terminal = {
  debug: (scope: string, message: string, details?: Array<string | null | undefined>) => write('debug', scope, message, details),
  info: (scope: string, message: string, details?: Array<string | null | undefined>) => write('info', scope, message, details),
  success: (scope: string, message: string, details?: Array<string | null | undefined>) => write('success', scope, message, details),
  warn: (scope: string, message: string, details?: Array<string | null | undefined>) => write('warn', scope, message, details),
  error: (scope: string, message: string, details?: Array<string | null | undefined>) => write('error', scope, message, details),
  list(scope: string, title: string, items: string[]) {
    write('info', scope, title)
    for (const item of items) {
      console.log(`  ${paint('-', 'dim')} ${maskSensitive(item)}`)
    }
  },
}
