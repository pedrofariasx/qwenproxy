export type FailureClass =
  | 'auth'
  | 'anti-bot'
  | 'quota'
  | 'upstream-5xx'
  | 'transient'
  | 'transport'
  | 'unknown'

export interface FailureSignal {
  code?: string | null
  status?: number | null
  message?: string | null
}

const AUTH_CODES = new Set([
  'Unauthorized',
  'Unauthenticated',
  'InvalidToken',
  'TokenExpired',
  'SessionExpired',
  'NotLoggedIn',
])

const QUOTA_CODES = new Set([
  'RateLimited',
  'QuotaExceeded',
  'MembershipLimit',
  'DailyLimit',
])

const ANTI_BOT_CODES = new Set([
  'FAIL_SYS_USER_VALIDATE',
  'RGV587_ERROR',
  'CaptchaBlocked',
])

const AUTH_PATTERNS = [
  /token has expired/i,
  /please log in again/i,
  /unauthorized/i,
  /invalid[\s_-]*token/i,
  /access[\s_-]*token/i,
  /not\s+logged\s+in/i,
  /do not have permission to access/i,
  /authentication\s+(failed|required|expired)/i,
]

const ANTI_BOT_PATTERNS = [
  /FAIL_SYS_USER_VALIDATE/,
  /_____tmd_____/,
  /RGV587_ERROR/,
  /baxia/i,
  /punish/i,
  /anti-bot/i,
  /security check/i,
]

const QUOTA_PATTERNS = [
  /rate[\s_-]*limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /wait about \d+ hour/i,
  /daily limit/i,
]

const TRANSIENT_PATTERNS = [
  /chat is in progress/i,
  /the chat is in progress/i,
  /warm pool empty/i,
  /bad_request/i,
]

export function classifyFailure(signal: FailureSignal | any): FailureClass {
  if (!signal) return 'unknown'
  const code = typeof signal === 'object' ? (signal.upstreamCode || signal.code || '') : ''
  const status = typeof signal === 'object' ? (signal.upstreamStatus || signal.status || 0) : 0
  const msg = typeof signal === 'object' ? (signal.message || '') : String(signal)

  if (AUTH_CODES.has(code)) return 'auth'
  if (ANTI_BOT_CODES.has(code)) return 'anti-bot'
  if (QUOTA_CODES.has(code)) return 'quota'

  if (status === 401) return 'auth'
  if (status === 429) return 'quota'
  if (status === 403) return 'anti-bot'
  if (status >= 500 && status < 600 && status !== 502) return 'upstream-5xx'

  for (const p of AUTH_PATTERNS) {
    if (p.test(msg)) return 'auth'
  }
  for (const p of ANTI_BOT_PATTERNS) {
    if (p.test(msg)) return 'anti-bot'
  }
  for (const p of QUOTA_PATTERNS) {
    if (p.test(msg)) return 'quota'
  }
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(msg)) return 'transient'
  }

  if (msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    return 'transport'
  }
  if (status === 502) return 'upstream-5xx'
  return 'unknown'
}

export interface RoutingAction {
  category: FailureClass
  canRetry: boolean
  triggerTokenRenewal: boolean
  tripCircuit: boolean
  quarantineAccount: boolean
  clientStatus: number
}

export function failureAction(signal: FailureSignal | any): RoutingAction {
  const cat = classifyFailure(signal)
  switch (cat) {
    case 'auth':
      return {
        category: 'auth',
        canRetry: true,
        triggerTokenRenewal: true,
        tripCircuit: false,
        quarantineAccount: false,
        clientStatus: 401,
      }
    case 'anti-bot':
      return {
        category: 'anti-bot',
        canRetry: false,
        triggerTokenRenewal: false,
        tripCircuit: true,
        quarantineAccount: true,
        clientStatus: 403,
      }
    case 'quota':
      return {
        category: 'quota',
        canRetry: false,
        triggerTokenRenewal: false,
        tripCircuit: false,
        quarantineAccount: true,
        clientStatus: 429,
      }
    case 'transient':
      return {
        category: 'transient',
        canRetry: true,
        triggerTokenRenewal: false,
        tripCircuit: false,
        quarantineAccount: false,
        clientStatus: 503,
      }
    case 'upstream-5xx':
      return {
        category: 'upstream-5xx',
        canRetry: true,
        triggerTokenRenewal: false,
        tripCircuit: true,
        quarantineAccount: false,
        clientStatus: 502,
      }
    case 'transport':
      return {
        category: 'transport',
        canRetry: true,
        triggerTokenRenewal: false,
        tripCircuit: false,
        quarantineAccount: false,
        clientStatus: 504,
      }
    default:
      return {
        category: 'unknown',
        canRetry: false,
        triggerTokenRenewal: false,
        tripCircuit: false,
        quarantineAccount: false,
        clientStatus: 500,
      }
  }
}
