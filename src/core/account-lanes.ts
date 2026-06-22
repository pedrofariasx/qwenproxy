export const ACCOUNT_LANE_SEPARATOR = '::lane-'

export function makeAccountLaneId(accountId: string, laneIndex: number): string {
  return `${accountId}${ACCOUNT_LANE_SEPARATOR}${laneIndex}`
}

export function isAccountLaneId(accountId: string): boolean {
  return accountId.includes(ACCOUNT_LANE_SEPARATOR)
}

export function getBaseAccountId(accountId: string): string {
  return accountId.split(ACCOUNT_LANE_SEPARATOR)[0]
}

export function getAccountLaneIndex(accountId: string): number | null {
  const [, lane] = accountId.split(ACCOUNT_LANE_SEPARATOR)
  if (!lane) return null
  const index = Number.parseInt(lane, 10)
  return Number.isFinite(index) ? index : null
}
