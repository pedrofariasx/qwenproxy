type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',
  info: '\x1b[34m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}

function colorsEnabled(): boolean {
  return process.env.NO_COLOR !== '1'
    && process.env.NO_COLOR !== 'true'
    && process.env.TERM !== 'dumb'
}

export function paint(value: string, level: LogLevel | 'dim' | 'bold' = 'info'): string {
  if (!colorsEnabled()) return value
  if (level === 'dim') return `${DIM}${value}${RESET}`
  if (level === 'bold') return `${BOLD}${value}${RESET}`
  return `${COLORS[level]}${value}${RESET}`
}

function now(): string {
  return new Date().toISOString().slice(11, 19)
}

function formatScope(scope: string): string {
  return paint(scope.padEnd(10).slice(0, 10), 'bold')
}

function write(level: LogLevel, scope: string, message: string, details?: Array<string | null | undefined>): void {
  const marker = {
    debug: 'DBG',
    info: 'INF',
    success: 'OK ',
    warn: 'WRN',
    error: 'ERR',
  }[level]

  const line = `${paint(now(), 'dim')} ${paint(marker, level)} ${formatScope(scope)} ${message}`
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  out(line)

  for (const detail of details || []) {
    if (!detail) continue
    out(`  ${paint('-', 'dim')} ${detail}`)
  }
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
      console.log(`  ${paint('-', 'dim')} ${item}`)
    }
  },
}
