/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

export function robustParseJSON(str: string): any {
  let sanitized = str.trim();
  
  // Remove markdown code blocks if present
  sanitized = sanitized.replace(/^```json\s*/, '').replace(/```$/, '').trim();

  // Try to find the first '{' and last '}'
  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  let jsonPart = sanitized.substring(firstBrace);
  
  // Try parsing directly first
  try {
    return JSON.parse(jsonPart);
  } catch (e) {
    // If it fails, let's try to fix common issues
  }

  // Attempt to fix missing closing braces
  let tempJson = jsonPart;
  let openBraces = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < tempJson.length; i++) {
    const char = tempJson[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
    }
  }

  // Append missing closing braces
  if (openBraces > 0) {
    tempJson += '}'.repeat(openBraces);
  }

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    // Still fails, try one more aggressive approach: find the last valid JSON structure
    // This is a bit complex, but for now let's just try to remove trailing comma if present before appending braces
    let aggressiveJson = jsonPart.trim();
    if (aggressiveJson.endsWith(',')) {
      aggressiveJson = aggressiveJson.slice(0, -1);
    }
    
    // Recalculate braces for the aggressive version
    let openB = 0;
    let inS = false;
    for (let i = 0; i < aggressiveJson.length; i++) {
      if (aggressiveJson[i] === '"' && (i === 0 || aggressiveJson[i-1] !== '\\')) inS = !inS;
      if (!inS) {
        if (aggressiveJson[i] === '{') openB++;
        if (aggressiveJson[i] === '}') openB--;
      }
    }
    if (openB > 0) aggressiveJson += '}'.repeat(openB);
    
    try {
      return JSON.parse(aggressiveJson);
    } catch (e2) {
      throw e; // Throw original error if all fixes fail
    }
  }
}
