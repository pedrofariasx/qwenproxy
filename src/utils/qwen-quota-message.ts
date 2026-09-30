const MAX_TERMINAL_QUOTA_MESSAGE_CHARS = 320;

function normalizeQuotaText(content: string): string {
  return String(content || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    // Apostrophes are not semantically useful here and make contractions vary.
    .replace(/'/g, '')
    .replace(/[.!?,:;()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUnsafeLeadingWrapper(content: string): boolean {
  // Provider notices arrive as plain assistant text. A quote, markdown blockquote,
  // code span, or bullet strongly suggests the model is DISCUSSING the notice,
  // not that Qwen itself is emitting the terminal quota response.
  return /^[>"'`“”‘’*-]/u.test(String(content || '').trim());
}

/**
 * Detect Qwen's terminal assistant message for exhausted daily chat quota.
 *
 * Qwen can return quota exhaustion as a normal HTTP-200/SSE assistant answer
 * instead of HTTP 429. Detection therefore uses the semantics and shape of a
 * SHORT provider notice rather than one exact localized sentence:
 *   1. an anchored exhaustion statement,
 *   2. daily/today scope,
 *   3. chat/message/conversation quota domain,
 *   4. an explicit retry/check-back-tomorrow instruction.
 *
 * Keeping the statement anchored and short prevents ordinary model prose that
 * quotes or explains quota behavior from quarantining an account.
 */
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

/**
 * Cheap streaming prefix probe. While this returns true, the response MAY still
 * become a provider quota notice and its assistant bytes should be held back.
 * As soon as the prefix diverges ("You are...", "Your implementation...", etc.)
 * normal streaming can resume immediately instead of buffering the whole reply.
 */
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
    'youve exhausted',
    'you have exhausted',
    'your daily',
    'your todays',
  ];

  return starts.some(start => start.startsWith(text) || text.startsWith(start));
}
