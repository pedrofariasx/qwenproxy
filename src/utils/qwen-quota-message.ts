const MAX_TERMINAL_QUOTA_MESSAGE_CHARS = 320;

function normalizeQuotaText(content: string): string {
  return String(content || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[.!?,:;()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUnsafeLeadingWrapper(content: string): boolean {
  return /^[>"'`“”‘’*-]/u.test(String(content || '').trim());
}

export function isDailyQuotaAssistantMessage(content: string): boolean {
  const raw = String(content || '').trim();
  if (!raw || raw.length > MAX_TERMINAL_QUOTA_MESSAGE_CHARS) return false;
  if (hasUnsafeLeadingWrapper(raw)) return false;

  const text = normalizeQuotaText(raw);
  if (!text) return false;

  const portugueseStart =
    /^voce (?:atingiu|alcancou|chegou ao|esgotou)\b/.test(text) ||
    /^o limite\b.*\b(?:foi atingido|foi alcancado|foi esgotado)\b/.test(text);
  const portugueseDomain = /\b(?:chat|chats|mensagem|mensagens|conversa|conversas)\b/.test(text);
  const portugueseDaily = /\b(?:hoje|diario|diaria)\b/.test(text);
  const portugueseLimit = /\blimite\b/.test(text);
  const portugueseRetry = /\b(?:tente(?: novamente)?|volte)\b.*\bamanha\b/.test(text);

  if (portugueseStart && portugueseDomain && portugueseDaily && portugueseLimit && portugueseRetry) {
    return true;
  }

  const englishStart =
    /^you(?:ve| have)? (?:reached|hit|exceeded|used up|exhausted)\b/.test(text) ||
    /^your (?:daily|todays)\b.*\b(?:limit|quota)\b.*\b(?:has been reached|is reached|has been exhausted|is exhausted)\b/.test(text);
  const englishDomain = /\b(?:chat|chats|message|messages|conversation|conversations|request|requests)\b/.test(text);
  const englishDaily = /\b(?:daily|today|todays)\b/.test(text);
  const englishLimit = /\b(?:limit|quota)\b/.test(text);
  const englishRetry = /\b(?:try again|please try again|check back|come back)\b.*\btomorrow\b/.test(text);

  return englishStart && englishDomain && englishDaily && englishLimit && englishRetry;
}

export function couldBeDailyQuotaAssistantMessagePrefix(content: string): boolean {
  const raw = String(content || '').trim();
  if (!raw) return true;
  if (raw.length > MAX_TERMINAL_QUOTA_MESSAGE_CHARS) return false;
  if (hasUnsafeLeadingWrapper(raw)) return false;

  const text = normalizeQuotaText(raw);
  const starts = [
    'voce atingiu',
    'voce alcancou',
    'voce chegou ao',
    'voce esgotou',
    'o limite',
    'youve reached',
    'you have reached',
    'you reached',
    'youve hit',
    'you have hit',
    'you hit',
    'youve exceeded',
    'you have exceeded',
    'you exceeded',
    'youve used up',
    'you have used up',
    'you used up',
    'youve exhausted',
    'you have exhausted',
    'you exhausted',
    'your daily',
    'your todays',
  ];

  return starts.some(start => start.startsWith(text) || text.startsWith(start));
}
