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

/**
 * Extrai JSON de formatos malformados comuns em tool calls de LLMs.
 * Lida com padrões como <arg_value>{...}</arg_value> ou tags XML residuais.
 */
function extractToolCallFromMalformed(input: string): string | null {
  // Tenta extrair JSON de padrões como <name="..."</arg_key><arg_value>{...}
  const argValueMatch = input.match(/<arg_value>\s*({[\s\S]*?})\s*<\/??arg_value?>/i);
  if (argValueMatch?.[1]) {
    return argValueMatch[1];
  }
  
  // Fallback: procura o primeiro { e o último } balanceado
  const firstBrace = input.indexOf('{');
  if (firstBrace === -1) return null;
  
  let depth = 0;
  for (let i = firstBrace; i < input.length; i++) {
    if (input[i] === '{') depth++;
    if (input[i] === '}') {
      depth--;
      if (depth === 0) {
        return input.substring(firstBrace, i + 1);
      }
    }
  }
  return null;
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
  
  // Tenta extrair de formato malformado primeiro (tool calls quebrados)
  const jsonCandidate = extractToolCallFromMalformed(sanitized) ?? extractJSONObjectCandidate(sanitized);

  if (!jsonCandidate) {
    return null;
  }

  try {
    return parseNativeJSON(jsonCandidate);
  } catch (originalError: unknown) {
    try {
      const repaired = jsonrepair(jsonCandidate);
      return parseNativeJSON(repaired);
    } catch (repairError: unknown) {
      // Log detalhado em debug mode para diagnóstico
      if (isDebugEnabled()) {
        console.error('[robustParseJSON] Falha total:', {
          original: str.slice(0, 200),
          candidate: jsonCandidate?.slice(0, 200),
          originalError: originalError instanceof Error ? originalError.message : String(originalError),
          repairError: repairError instanceof Error ? repairError.message : String(repairError)
        });
      }
      throw originalError; // Propaga o erro original para o parser lidar
    }
  }
}

function isDebugEnabled(): boolean {
  return process.env.DEBUG_QWEN_PROXY === '1';
}
