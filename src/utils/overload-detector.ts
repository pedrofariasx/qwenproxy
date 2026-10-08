const OVERLOAD_PATTERNS = [
  /high\s+demand/i,
  /problem\s+connecting/i,
  /try\s+again\s+later/i,
  /temporarily\s+unavailable/i,
  /service\s+(is\s+)?overloaded/i,
  /too\s+many\s+requests/i,
  /server\s+is\s+busy/i,
  /experiencing\s+high\s+(traffic|volume|load)/i,
  /unable\s+to\s+connect/i,
  /connection\s+(problem|error|issue)/i,
  /alta\s+demanda/i,
  /problema\s+de\s+conex/i,
  /tente\s+novamente\s+mais\s+tarde/i,
  /servidor\s+ocupado/i,
  /indisponível\s+no\s+momento/i,
];

export const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000;

export function isOverloadMessage(content: string | null | undefined): boolean {
  const text = (content || '').trim();
  if (!text || text.length > 500) return false;
  return OVERLOAD_PATTERNS.some((re) => re.test(text));
}
