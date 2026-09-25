/**
 * Truncation detector for LLM responses.
 *
 * Detects whether an upstream generation was prematurely cut off by token limits,
 * network interruption, or upstream capacity, so that the proxy can automatically
 * continue generation transparently without requiring manual user intervention.
 */

export function isTruncatedResponse(content: string, finishReason?: string | null): boolean {
  if (finishReason === 'length') {
    return true;
  }

  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 20) {
    return false;
  }

  // 1. Unclosed markdown code fences: an odd number of ``` means a code block was opened and never closed
  const codeFenceMatches = trimmed.match(/```/g);
  if (codeFenceMatches && codeFenceMatches.length % 2 === 1) {
    return true;
  }

  // 2. Trailing syntax operators that clearly indicate an incomplete line
  if (/[=+\-*/&|:,({[<]$/.test(trimmed)) {
    return true;
  }

  // 3. Incomplete keywords at the end of the text expecting immediate continuation
  if (/\b(const|let|var|function|return|import|export|class|async|await|switch|case|while|for)(\s+[a-zA-Z0-9_]*\s*=?)?$/.test(trimmed)) {
    return true;
  }

  // 4. Unclosed markdown link [text](url...
  if (/\[[^\]]*\]\([^)]*$/.test(trimmed)) {
    return true;
  }

  return false;
}
