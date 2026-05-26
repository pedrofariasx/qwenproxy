/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

interface SanitizeResult {
  result: string;
  openBraces: number;
  openBrackets: number;
  lastBalancedIndex: number;
}

function sanitizeJsonString(input: string): SanitizeResult {
  let result = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      const validEscapes = ['n', 'r', 't', 'u', '"', '\\', '/'];
      if (validEscapes.includes(char)) {
        if (char === 'u') {
          const next4 = input.substring(i + 1, i + 5);
          const isHex = /^[0-9a-fA-F]{4}$/.test(next4);
          result += isHex ? '\\' + char : '\\\\' + char;
        } else if (['n', 'r', 't'].includes(char)) {
          const isWinPath = /[a-zA-Z]:\\/i.test(input) || /[a-zA-Z]:\//i.test(input);
          const nextChar = input[i + 1] || '';
          result += (isWinPath && /^[a-zA-Z0-9]/.test(nextChar)) ? '\\\\' + char : '\\' + char;
        } else {
          result += '\\' + char;
        }
      } else {
        result += '\\\\' + char;
      }
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      if (char === '\n') result += '\\n';
      else if (char === '\r') result += '\\r';
      else if (char === '\t') result += '\\t';
      else if (char.charCodeAt(0) < 32) result += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      else result += char;
    } else {
      result += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;
      if (openBraces === 0 && openBrackets === 0 && i > 0) {
        lastBalancedIndex = result.length - 1;
      }
    }
  }

  return { result, openBraces, openBrackets, lastBalancedIndex };
}

function closeOpenBraces(s: SanitizeResult): string {
  let json = s.result;
  if (s.lastBalancedIndex !== -1 && (s.openBraces !== 0 || s.openBrackets !== 0 || json.length > s.lastBalancedIndex + 1)) {
    return json.substring(0, s.lastBalancedIndex + 1);
  }
  if (s.openBrackets > 0) json += ']'.repeat(s.openBrackets);
  if (s.openBraces > 0) json += '}'.repeat(s.openBraces);
  return json;
}

export function robustParseJSON(str: string): any {
  let sanitized = str.trim();

  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  let jsonPart = sanitized.substring(firstBrace);

  try {
    return JSON.parse(jsonPart);
  } catch (e) {
  }

  let currentJson = jsonPart.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  currentJson = currentJson.replace(/([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g, '$1"$2":');
  currentJson = currentJson.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g, '$1$2:');

  try {
    return JSON.parse(currentJson);
  } catch (e) {
  }

  let cleaned = currentJson.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  const sanitized_ = sanitizeJsonString(cleaned);
  const tempJson = closeOpenBraces(sanitized_);

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    let aggressive = sanitized_.result.trim();
    if (aggressive.endsWith(',')) aggressive = aggressive.slice(0, -1);

    const aggResult = sanitizeJsonString(aggressive);
    let aggFixed = aggResult.result;
    if (aggResult.openBrackets > 0) aggFixed += ']'.repeat(aggResult.openBrackets);
    if (aggResult.openBraces > 0) aggFixed += '}'.repeat(aggResult.openBraces);

    try {
      return JSON.parse(aggFixed);
    } catch (e2) {
      throw e;
    }
  }
}
