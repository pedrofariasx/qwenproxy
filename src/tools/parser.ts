/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 * Supports both JSON and Hermes-style XML <parameter> formats.
 */

import crypto from 'crypto';
import { robustParseJSON } from '../utils/json.js';
import { logger } from '../core/logger.js';
import type { ParsedToolCall } from './types';
import type { FunctionToolDefinition } from './types';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

// ─── XML Helpers ───────────────────────────────────────────────────────────────

const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;
const TOOL_END = '</tool_call>';

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function unescapeDoubleEscaped(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return content;
  
  const isJsonLike = trimmed.startsWith('{') || trimmed.startsWith('[');
  const isXmlLike = trimmed.startsWith('<');
  
  if (!isJsonLike && !isXmlLike) return content;
  
  const firstQuoteIdx = trimmed.indexOf('"');
  if (firstQuoteIdx === -1) return content;
  
  const firstEscapedQuoteIdx = trimmed.indexOf('\\"');
  
  if (firstEscapedQuoteIdx !== -1 && (firstQuoteIdx === -1 || firstEscapedQuoteIdx < firstQuoteIdx)) {
    return content
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  
  return content;
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch { /* ignore */ }
  }
  return value;
}

/**
 * Extract tool name from the opening tag attribute or a <name> child element.
 */
function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(/<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return '';
}

/**
 * Infer tool name by matching parameter keys against tool definitions.
 * Only returns a name if exactly one tool matches all argument keys.
 */
function inferToolNameFromParameters(args: Record<string, unknown>, tools: FunctionToolDefinition[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return '';

  const matches = tools.filter((tool) => {
    const fn = tool?.type === 'function' ? tool.function : (tool as any)?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function' ? matches[0].function : (matches[0] as any)?.function;
    return fn?.name || '';
  }

  return '';
}

/**
 * Parse Hermes-style XML <parameter name="...">value</parameter> format.
 */
function parseXmlParameterToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Try to recover a tool call from a block that may have unclosed <parameter> tags
 * (e.g. stream was cut off before </parameter> or </tool_call>).
 */
function parseRecoverableXmlToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = closedParameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    lastClosedEnd = closedParameterRe.lastIndex;
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
  if (unclosedMatch) {
    args[unclosedMatch[1]] = coerceParameterValue(unclosedMatch[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

// ─── String-Aware Tag Detection ─────────────────────────────────────────────────

function findToolEndIndex(buffer: string): number {
  const tagLen = TOOL_END.length;
  const limit = buffer.length - tagLen;
  let inString = false;
  let escaped = false;

  for (let i = 0; i <= limit; i++) {
    const ch = buffer[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString || ch !== '<') continue;
    let match = true;
    for (let j = 1; j < tagLen; j++) {
      const c = buffer.charCodeAt(i + j);
      const t = TOOL_END.charCodeAt(j);
      if (c !== t && (c | 0x20) !== (t | 0x20)) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}



// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = '<tool_call>';

function findPartialToolOpenIndex(buffer: string): number {
  const prefix = '<tool_call';
  const prefixLen = prefix.length;
  const bufLen = buffer.length;

  let lastPartialIdx = -1;
  for (let i = bufLen - 1; i >= Math.max(0, bufLen - prefixLen - 1); i--) {
    if (buffer[i] !== '<') continue;
    let match = true;
    for (let j = 1; j < prefixLen && i + j < bufLen; j++) {
      const c = buffer.charCodeAt(i + j);
      const t = prefix.charCodeAt(j);
      if (c !== t && ((c | 0x20) !== (t | 0x20))) { match = false; break; }
    }
    if (match) {
      lastPartialIdx = i;
      break;
    }
  }
  if (lastPartialIdx !== -1 && buffer.indexOf('>', lastPartialIdx) === -1) return lastPartialIdx;

  for (let i = 1; i < TOOL_START_LITERAL.length; i++) {
    const sub = TOOL_START_LITERAL.substring(0, i);
    const subLen = sub.length;
    if (bufLen < subLen) continue;
    let match = true;
    for (let j = 0; j < subLen; j++) {
      const c = buffer.charCodeAt(bufLen - subLen + j);
      const t = sub.charCodeAt(j);
      if (c !== t && (c | 0x20) !== (t | 0x20)) { match = false; break; }
    }
    if (match) return bufLen - i;
  }
  return -1;
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private emittedToolCallCount = 0;
  private pendingLeadIn = '';
  private tools: FunctionToolDefinition[] = [];

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(tools: FunctionToolDefinition[] = []) {
    this.tools = tools;
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: FunctionToolDefinition[]): void {
    this.tools = tools;
  }

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        if (this.buffer.indexOf('<') === -1) {
          if (this.emittedToolCallCount === 0) result.text += this.buffer;
          this.buffer = '';
          break;
        }
        const match = this.buffer.match(TOOL_OPEN_RE);
        if (match && match.index !== undefined) {
          // Text before the tool call tag
          const textBefore = this.buffer.substring(0, match.index);
          result.text += textBefore;
          this.insideTool = true;
          this.currentOpenTag = match[0];
          this.buffer = this.buffer.substring(match.index + match[0].length);
          continue;
        } else {
          // No full open tag found. Check for partial at end.
          const partialIdx = findPartialToolOpenIndex(this.buffer);
          const flushIndex = partialIdx === -1 ? this.buffer.length : partialIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
            // Only emit as content if no tool calls have been emitted yet
            if (this.emittedToolCallCount === 0) {
              result.text += textToEmit;
            }
            this.buffer = this.buffer.substring(flushIndex);
          }
          break;
        }
       } else {
        let endIdx = findToolEndIndex(this.buffer);
         if (endIdx === -1) endIdx = this.buffer.indexOf(TOOL_END);
         if (endIdx !== -1) {
          const content = this.buffer.substring(0, endIdx);
          this.buffer = this.buffer.substring(endIdx + TOOL_END.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
          if (this.buffer.length > 0) {
            const nextMatch = this.buffer.match(TOOL_OPEN_RE);
            if (nextMatch && nextMatch.index !== undefined) {
              result.text += this.buffer.substring(0, nextMatch.index);
              this.insideTool = true;
              this.currentOpenTag = nextMatch[0];
              this.buffer = this.buffer.substring(nextMatch.index + nextMatch[0].length);
            } else {
              const partialIdx = findPartialToolOpenIndex(this.buffer);
              const flushIdx = partialIdx === -1 ? this.buffer.length : partialIdx;
              result.text += this.buffer.substring(0, flushIdx);
              this.buffer = this.buffer.substring(flushIdx);
            }
          }
        } else {
          break;
        }
      }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        const recovered = this.tryRecoverToolCall(trimmed);
        if (recovered) {
          result.toolCalls.push(recovered);
          this.emittedToolCallCount++;
        } else {
          logger.warn('[parser] Dropping unrecoverable unclosed tool call at end of stream');
          result.text += this.pendingLeadIn;
          result.text += this.currentOpenTag + this.buffer + TOOL_END;
        }
      } else {
        result.text += this.pendingLeadIn;
      }
    } else {
      result.text += this.buffer;
    }

    this.buffer = '';
    this.insideTool = false;
    this.currentOpenTag = TOOL_START_LITERAL;
    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  // ─── Internal Methods ──────────────────────────────────────────────────────

  private processToolContent(content: string, result: ParserResult): void {
    let t = content.trim();
    if (!t) {
      logger.warn('[parser] Dropping empty tool call block');
      if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = '';
      return;
    }

    t = unescapeDoubleEscaped(t);

    const xmlParsed = parseXmlParameterToolCall(t, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      result.toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      this.emittedToolCallCount++;
      this.pendingLeadIn = '';
      return;
    }

    // 2) Try JSON array format
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = '';
        return;
      } catch {
        // Fall through to JSON object parsing
      }
    }

    // 3) Try JSON object format (single or multiple)
    if (t.startsWith('{') || t.includes('"name"')) {
      const calls = this.parseToolContent(t);
      if (calls.length > 0) {
        for (const tc of calls) {
          if (!tc.name || tc.name === '') {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          if (tc.name) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = '';
        return;
      }
    }

    // 4) Tool call is malformed and unrecoverable.
    logger.warn('[parser] Dropping malformed tool call block', { 
      contentPreview: t.substring(0, 500), 
      hasName: t.includes('"name"') || t.includes('"tool"') || t.includes('tool_name'),
      hasArgs: t.includes('"arguments"') || t.includes('"args"') || t.includes('"parameters"') || t.includes('"input"'),
      first100Chars: t.substring(0, 100)
    });
    result.text += this.pendingLeadIn;
    result.text += this.currentOpenTag + content + TOOL_END;
    this.pendingLeadIn = '';
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    const unescaped = unescapeDoubleEscaped(block);
    
    const xmlParsed = parseXmlParameterToolCall(unescaped, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      return {
        id: `call_${crypto.randomUUID()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      };
    }

    const recovered = parseRecoverableXmlToolCall(unescaped, this.currentOpenTag, this.tools);
    if (recovered) {
      return {
        id: `call_${crypto.randomUUID()}`,
        name: recovered.name,
        arguments: recovered.arguments,
      };
    }

    const jsonParsed = this.parseToolContent(unescaped);
    if (jsonParsed.length > 0) {
      const first = jsonParsed[0];
      const attrName = extractToolName(this.currentOpenTag, unescaped);
      if (attrName && !first.name) first.name = attrName;
      if (first.name) return first;
    }

    return null;
  }

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    
    // Try parsing as single JSON first
    try {
      const parsed = robustParseJSON(str);
      if (parsed && typeof parsed === 'object') {
        const tc = this.parseToolCall(parsed);
        if (tc) calls.push(tc);
      }
    } catch { /* ignore */ }
    
    // Always try line-by-line parsing for multi-JSON content (independent of single parse)
    if (str.includes('\n')) {
      const lines = str.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}'));
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') {
            const tc = this.parseToolCall(parsed);
            if (tc && !calls.some(c => c.name === tc.name && JSON.stringify(c.arguments) === JSON.stringify(tc.arguments))) {
              calls.push(tc);
            }
          }
        } catch { /* ignore */ }
      }
    }
    
    return calls;
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== 'object') return null;
    
    const name = parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== 'string' || name.length === 0) return null;
    
    let args = parsed.arguments || parsed.function?.arguments || parsed.args || parsed.parameters || parsed.input || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return {
      id: parsed.id || parsed.tool_call_id || `call_${crypto.randomUUID()}`,
      name,
      arguments: args,
    };
  }
}
