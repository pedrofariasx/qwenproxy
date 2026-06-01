/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

import { logger } from "../core/logger.js";

const isDebug = process.env.TOOLCALL_DEBUG === "1";

function sanitizeAndBalance(input: string): {
  result: string;
  openBraces: number;
  openBrackets: number;
} {
  let out = "";
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      const validEscapes = ["n", "r", "t", "u", '"', "\\", "/"];
      if (validEscapes.includes(char)) {
        if (char === "u") {
          const next4 = input.substring(i + 1, i + 5);
          out += /^[0-9a-fA-F]{4}$/.test(next4) ? "\\" + char : "\\\\" + char;
        } else if (["n", "r", "t"].includes(char)) {
          const isWinPath =
            /[a-zA-Z]:\\/i.test(input) || /[a-zA-Z]:\//i.test(input);
          const nextChar = input[i + 1] || "";
          out +=
            isWinPath && /^[a-zA-Z0-9]/.test(nextChar)
              ? "\\\\" + char
              : "\\" + char;
        } else {
          out += "\\" + char;
        }
      } else {
        out += "\\\\" + char;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString) {
      if (char === "\n") out += "\\n";
      else if (char === "\r") out += "\\r";
      else if (char === "\t") out += "\\t";
      else if (char.charCodeAt(0) < 32)
        out += "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
      else out += char;
    } else {
      out += char;
      if (char === "{") openBraces++;
      if (char === "}") openBraces--;
      if (char === "[") openBrackets++;
      if (char === "]") openBrackets--;
    }
  }
  return { result: out, openBraces, openBrackets };
}

function closeBraces(
  input: string,
  openBraces: number,
  openBrackets: number,
): string {
  let out = input;
  if (openBrackets > 0) out += "]".repeat(openBrackets);
  if (openBraces > 0) out += "}".repeat(openBraces);
  return out;
}

export function robustParseJSON(str: string): any {
  if (isDebug) {
    logger.debug("[json] robustParseJSON: starting", {
      inputLength: str.length,
      inputPreview: str.substring(0, 200),
    });
  }

  let sanitized = str.trim();
  sanitized = sanitized
    .replace(/^```json\s*/, "")
    .replace(/```$/, "")
    .trim();

  const firstBrace = sanitized.indexOf("{");
  if (firstBrace === -1) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: no opening brace found");
    }
    return null;
  }

  let jsonPart = sanitized.substring(firstBrace);
  try {
    const result = JSON.parse(jsonPart);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: direct parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: direct parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    /* continue */
  }

  let currentJson = jsonPart.replace(
    /([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g,
    '$1"$2"$3',
  );
  currentJson = currentJson.replace(
    /([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g,
    '$1"$2":',
  );
  currentJson = currentJson.replace(
    /([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g,
    "$1$2:",
  );

  try {
    const result = JSON.parse(currentJson);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: quote-fix parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: quote-fix parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    /* continue */
  }

  let cleaned = currentJson.trim();
  while (
    cleaned.length > 0 &&
    !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])
  ) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  const {
    result: fixedJson,
    openBraces,
    openBrackets,
  } = sanitizeAndBalance(cleaned);
  let lastBalancedIndex = -1;

  {
    let ob = 0,
      bk = 0,
      ins = false,
      esc = false;
    for (let i = 0; i < fixedJson.length; i++) {
      const c = fixedJson[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        ins = !ins;
        continue;
      }
      if (!ins) {
        if (c === "{") ob++;
        if (c === "}") ob--;
        if (c === "[") bk++;
        if (c === "]") bk--;
        if (ob === 0 && bk === 0) lastBalancedIndex = i;
      }
    }
  }

  let tempJson = fixedJson;
  if (
    lastBalancedIndex !== -1 &&
    (openBraces !== 0 ||
      openBrackets !== 0 ||
      fixedJson.length > lastBalancedIndex + 1)
  ) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: truncated to balanced index", {
        lastBalancedIndex,
        originalLength: fixedJson.length,
        truncatedLength: tempJson.length,
      });
    }
  } else if (openBraces > 0 || openBrackets > 0) {
    tempJson = closeBraces(fixedJson, openBraces, openBrackets);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: closed braces", {
        openBraces,
        openBrackets,
        resultLength: tempJson.length,
      });
    }
  }

  try {
    const result = JSON.parse(tempJson);
    if (isDebug) {
      logger.debug("[json] robustParseJSON: balanced-parse succeeded", {
        resultType: typeof result,
        resultPreview: JSON.stringify(result).substring(0, 200),
      });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      logger.debug("[json] robustParseJSON: balanced-parse failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    let aggressive = fixedJson.trim();
    if (aggressive.endsWith(",")) aggressive = aggressive.slice(0, -1);
    const {
      result: aggFixed,
      openBraces: ob,
      openBrackets: bk,
    } = sanitizeAndBalance(aggressive);
    try {
      const result = JSON.parse(closeBraces(aggFixed, ob, bk));
      if (isDebug) {
        logger.debug("[json] robustParseJSON: aggressive-parse succeeded", {
          resultType: typeof result,
          resultPreview: JSON.stringify(result).substring(0, 200),
        });
      }
      return result;
    } catch {
      if (isDebug) {
        logger.debug("[json] robustParseJSON: all parse attempts failed", {
          originalError: e instanceof Error ? e.message : String(e),
        });
      }
      throw e;
    }
  }
}
