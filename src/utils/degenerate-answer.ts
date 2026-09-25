/**
 * Detection of degenerate LLM replies: terse acknowledgments ("Yes", "Sim",
 * "OK") that carry no actual answer. Text file uploads sometimes confuse the
 * model into producing one of these; the proxy must never surface them as the
 * final answer.
 */

const DEGENERATE_PHRASES = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'y',
  'ok',
  'okay',
  'oke',
  'okey',
  'sim',
  'claro',
  'claro que sim',
  'certo',
  'perfeito',
  'entendido',
  'com certeza',
  'confirmado',
  'afirmativo',
  'positivo',
  'roger',
  'fine',
  'done',
  'received',
  'okido',
  'got it',
  'all good',
];

// Matches a reply consisting only of the phrases above plus light punctuation.
const DEGENERATE_RE = new RegExp(
  `^(?:\\s*(?:${DEGENERATE_PHRASES.join('|')})\\s*[.!?]?\\s*)+$`,
  'i',
);

export function isDegenerateAnswer(content: string | null | undefined): boolean {
  const text = (content || '').trim();
  if (!text || text.length > 200) return false;
  return DEGENERATE_RE.test(text);
}

/**
 * Evaluates whether an early answer stream can safely bypass the 800-byte hold
 * buffer and release immediately to achieve zero-latency TTFT.
 *
 * If the response already shows technical structure (code fence, headers, JSON,
 * multiple lines, or technical keywords), it is guaranteed not to be a terse
 * degenerate acknowledgment ("Yes", "OK", "Sim") and can be flushed instantly.
 */
export function canFastReleaseGuard(content: string): boolean {
  const trimmed = (content || '').trim();
  if (!trimmed || trimmed.length < 5) return false;

  // If it starts with any known degenerate word, do NOT fast release
  if (DEGENERATE_RE.test(trimmed)) return false;
  const firstWord = trimmed.split(/[\s,.:;!?]/)[0].toLowerCase();
  if (DEGENERATE_PHRASES.includes(firstWord)) return false;

  // 1. Code blocks, markdown headers, lists, or JSON structures
  if (/^(```|#+ |\* |- |\d+\. |\{|\[|> )/.test(trimmed)) {
    return true;
  }

  // 2. Multi-line content with reasonable length
  if (trimmed.includes('\n') && trimmed.length >= 25) {
    return true;
  }

  // 3. Technical code keywords near the start
  if (/^(const|let|var|function|import|export|class|def|public|private|package|type|interface|<!DOCTYPE|<html|<div)\b/.test(trimmed)) {
    return true;
  }

  // 4. Clearly substantive answers longer than 80 chars that aren't degenerate
  if (trimmed.length >= 80) {
    return true;
  }

  return false;
}

/**
 * Builds the directive appended to a prompt that instructs the model to answer
 * the last user message in full and to never reply with a bare acknowledgment.
 */
export function buildAnswerDirective(
  previousReply?: string,
  reason = 'a brief reply that does not answer the question',
): string {
  return [
    '',
    '---',
    `[SYSTEM DIRECTIVE] ${previousReply
      ? `Your previous reply (${previousReply.trim().slice(0, 80)}) was rejected because ${reason}. `
      : ''}Always answer the FINAL "User:" block above with a complete, detailed, and unambiguous response in the same language.`,
    'NEVER reply with only a short acknowledgment such as "Yes", "OK", "Sim", "Entendido", or a bare confirmation — those are treated as invalid answers. If the final User message is a question, answer it fully; if it is an instruction, execute it fully and report what you did.',
    '[/SYSTEM DIRECTIVE]',
  ].join('\n');
}