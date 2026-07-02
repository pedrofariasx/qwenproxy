/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

function sanitizeAndBalance(input: string): { result: string; openBraces: number; openBrackets: number; inString: boolean } {
  let out = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      const validEscapes = ['n', 'r', 't', 'u', '"', '\\', '/'];
      if (validEscapes.includes(char)) {
        if (char === 'u') {
          const next4 = input.substring(i + 1, i + 5);
          out += /^[0-9a-fA-F]{4}$/.test(next4) ? '\\' + char : '\\\\' + char;
        } else if (['n', 'r', 't'].includes(char)) {
          const isWinPath = /[a-zA-Z]:\\/i.test(input) || /[a-zA-Z]:\//i.test(input);
          const nextChar = input[i + 1] || '';
          out += (isWinPath && /^[a-zA-Z0-9]/.test(nextChar)) ? '\\\\' + char : '\\' + char;
        } else {
          out += '\\' + char;
        }
      } else {
        out += '\\\\' + char;
      }
      escaped = false;
      continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; out += char; continue; }
    if (inString) {
      if (char === '\n') out += '\\n';
      else if (char === '\r') out += '\\r';
      else if (char === '\t') out += '\\t';
      else if (char.charCodeAt(0) < 32) out += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      else out += char;
    } else {
      out += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;
    }
  }
  return { result: out, openBraces, openBrackets, inString };
}

function closeBraces(input: string, openBraces: number, openBrackets: number, inString: boolean = false): string {
  let out = input;
  if (inString) out += '"';
  if (openBrackets > 0) out += ']'.repeat(openBrackets);
  if (openBraces > 0) out += '}'.repeat(openBraces);
  return out;
}

function quoteUnquotedStringValues(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (escaped) { out += ch; escaped = false; i++; continue; }
    if (ch === '\\' && inString) { out += ch; escaped = true; i++; continue; }
    if (ch === '"') { inString = !inString; out += ch; i++; continue; }
    if (inString) { out += ch; i++; continue; }

    if (ch === ':') {
      out += ch;
      i++;
      let ws = '';
      while (i < input.length && /\s/.test(input[i])) { ws += input[i]; i++; }
      out += ws;
      if (i >= input.length) break;

      const next = input[i];
      if (next === '"' || next === '{' || next === '[' || next === '-' || /[0-9]/.test(next)) {
        continue;
      }
      const rest = input.substring(i);
      if (/^(true|false|null)\b/.test(rest)) {
        continue;
      }

      let val = '';
      let depthBrace = 0;
      let depthBracket = 0;
      let j = i;
      while (j < input.length) {
        const c = input[j];
        if (c === '{') depthBrace++;
        else if (c === '}') {
          if (depthBrace === 0) break;
          depthBrace--;
        } else if (c === '[') depthBracket++;
        else if (c === ']') {
          if (depthBracket === 0) break;
          depthBracket--;
        } else if (c === ',' && depthBrace === 0 && depthBracket === 0) {
          break;
        }
        val += c;
        j++;
      }

      if (val.length > 0) {
        const escapedVal = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        out += '"' + escapedVal + '"';
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function fixMissingOpeningQuotes(input: string): string {
  let out = input;
  let prev: string;
  do {
    prev = out;
    out = out.replace(
      /([{,[]\s*"[a-zA-Z_][\w]*"\s*:\s*)([^"\s,}\]][^"\n]*?)"([\s,}\]])/g,
      '$1"$2"$3'
    );
    out = out.replace(
      /([{,[]\s*[a-zA-Z_][\w]*\s*:\s*)([^"\s,}\]][^"\n]*?)"([\s,}\]])/g,
      '$1"$2"$3'
    );
    out = out.replace(
      /(:\s*)([A-Za-z_][\w.-]*?)"([\s,}\]])/g,
      '$1"$2"$3'
    );
  } while (out !== prev);
  return out;
}

function quoteUnquotedKeys(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString) {
      out += ch;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      const ident = input.slice(i, j);
      let k = j;
      while (k < input.length && /\s/.test(input[k])) k++;
      if (k < input.length && input[k] === ':') {
        out += '"' + ident + '"';
      } else {
        out += ident;
      }
      i = j - 1;
      continue;
    }

    out += ch;
  }

  return out;
}

export function robustParseJSON(str: string): any {
  let sanitized = str.trim();
  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  const jsonPart = sanitized.substring(firstBrace);
  try { return JSON.parse(jsonPart); } catch { /* continue */ }

  let currentJson = quoteUnquotedKeys(jsonPart);
  currentJson = fixMissingOpeningQuotes(currentJson);
  currentJson = quoteUnquotedStringValues(currentJson);
  currentJson = currentJson.replace(/([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g, '$1"$2":');
  currentJson = currentJson.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g, '$1$2:');

  try { return JSON.parse(currentJson); } catch { /* continue */ }

  let cleaned = currentJson.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  const { result: fixedJson, openBraces, openBrackets, inString } = sanitizeAndBalance(cleaned);
  let lastBalancedIndex = -1;

  { let ob = 0, bk = 0, ins = false, esc = false;
    for (let i = 0; i < fixedJson.length; i++) {
      const c = fixedJson[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { ins = !ins; continue; }
      if (!ins) {
        if (c === '{') ob++; if (c === '}') ob--;
        if (c === '[') bk++; if (c === ']') bk--;
        if (ob === 0 && bk === 0) lastBalancedIndex = i;
      }
    }
  }

  let tempJson = fixedJson;
  if (lastBalancedIndex !== -1 && (openBraces !== 0 || openBrackets !== 0 || fixedJson.length > lastBalancedIndex + 1)) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
  } else if (openBraces > 0 || openBrackets > 0 || inString) {
    tempJson = closeBraces(fixedJson, openBraces, openBrackets, inString);
  }

  try { return JSON.parse(tempJson); } catch {
    let aggressive = fixedJson.trim();
    aggressive = aggressive.replace(/,\s*([}\]])/g, '$1');
    const { result: aggFixed, openBraces: ob, openBrackets: bk, inString: aggInString } = sanitizeAndBalance(aggressive);
  try { return JSON.parse(closeBraces(aggFixed, ob, bk, aggInString)); } catch {
    return null;
  }
}
}
