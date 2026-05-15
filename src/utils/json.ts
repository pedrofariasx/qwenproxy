/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

import { jsonrepair } from 'jsonrepair';

function stripMarkdownCodeFence(input: string): string {
  return input.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
}

function extractJSONObjectCandidate(input: string): string | null {
  const firstBrace = input.indexOf('{');
  if (firstBrace === -1) {
    return null;
  }

  return input.substring(firstBrace).trim();
}

function parseNativeJSON(jsonCandidate: string): unknown {
  return JSON.parse(jsonCandidate) as unknown;
}

/**
 * Tenta fazer parse de JSON vindo de modelos, usando reparo quando o conteúdo
 * está quase válido, mas com pequenos erros de formatação.
 */
export function robustParseJSON(str: string): unknown {
  const sanitized = stripMarkdownCodeFence(str.trim());
  const jsonCandidate = extractJSONObjectCandidate(sanitized);

  if (!jsonCandidate) {
    return null;
  }

  try {
    return parseNativeJSON(jsonCandidate);
  } catch {
    const repaired = jsonrepair(jsonCandidate);
    return parseNativeJSON(repaired);
  }
}
