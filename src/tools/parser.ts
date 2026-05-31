/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 * Supports both JSON and Hermes-style XML <parameter> formats.
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
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

type RawToolJsonCandidate = {
  start: number;
  end: number | null;
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function splitInlineArguments(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      quote = ch === '“' ? '”' : ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function stripInlineQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '“' && last === '”')) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }

  const args: Record<string, unknown> = {};
  for (const part of splitInlineArguments(trimmed)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue;
    args[key] = coerceParameterValue(stripInlineQuotes(part.slice(eq + 1)));
  }
  return args;
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
    const fn = tool?.type === 'function'
      ? ((tool as any).function || tool)
      : (tool as any)?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function'
      ? ((matches[0] as any).function || matches[0])
      : (matches[0] as any)?.function;
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

// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = '<tool_call>';

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  // Check if there's a partial opening tag like `<tool_call` without closing `>`
  const idx = lower.lastIndexOf('<tool_call');
  if (idx !== -1 && lower.indexOf('>', idx) === -1) return idx;

  // Check for partial prefix at end (e.g. `<tool`, `<tool_`, `<tool_c`)
  for (let i = 1; i < TOOL_START_LITERAL.length; i++) {
    if (lower.endsWith(TOOL_START_LITERAL.substring(0, i))) return buffer.length - i;
  }
  return -1;
}

function findPartialInlineToolIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf('tool:');
  if (idx === -1) return -1;

  const tail = buffer.substring(idx);
  if (!/^tool:\s*[A-Za-z_][\w-]*(?:\s*\([^)]*)?$/i.test(tail.trim())) return -1;
  if (tail.includes(')')) return -1;
  return idx;
}

function findBalancedJsonObjectEnd(input: string, start: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}

function looksLikeRawToolJson(prefix: string, allowedToolNames: Set<string>): boolean {
  const preview = prefix.slice(0, 1200);
  const hasNameField = /"(?:name|tool_name|tool)"\s*:/.test(preview)
    || /"function"\s*:\s*\{[\s\S]{0,500}"name"\s*:/.test(preview);
  if (!hasNameField) return false;

  const hasArgumentField = /"(?:arguments|args|parameters|input)"\s*:/.test(preview)
    || /"function"\s*:\s*\{[\s\S]{0,500}"arguments"\s*:/.test(preview);
  if (hasArgumentField) return true;

  for (const name of allowedToolNames) {
    if (preview.includes(`"${name}"`) || preview.includes(`"*${name}"`)) return true;
  }

  return false;
}

function findRawToolJsonCandidate(buffer: string, allowedToolNames: Set<string>): RawToolJsonCandidate | null {
  if (allowedToolNames.size === 0) return null;

  let start = buffer.indexOf('{');
  while (start !== -1) {
    const tail = buffer.substring(start);
    if (looksLikeRawToolJson(tail, allowedToolNames)) {
      return {
        start,
        end: findBalancedJsonObjectEnd(buffer, start),
      };
    }
    start = buffer.indexOf('{', start + 1);
  }

  return null;
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private emittedToolCallCount = 0;
  private pendingLeadIn = '';
  private tools: FunctionToolDefinition[] = [];
  private allowedToolNames = new Set<string>();

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(tools: FunctionToolDefinition[] = []) {
    this.tools = tools;
    this.refreshAllowedToolNames();
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: FunctionToolDefinition[]): void {
    this.tools = tools;
    this.refreshAllowedToolNames();
  }

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const match = this.buffer.match(TOOL_OPEN_RE);
        const rawCandidate = findRawToolJsonCandidate(this.buffer, this.allowedToolNames);

        if (
          rawCandidate
          && (!match || match.index === undefined || rawCandidate.start < match.index)
        ) {
          const textBefore = this.buffer.substring(0, rawCandidate.start);
          this.pendingLeadIn += textBefore;

          if (rawCandidate.end === null) {
            this.buffer = this.buffer.substring(rawCandidate.start);
            break;
          }

          const content = this.buffer.substring(rawCandidate.start, rawCandidate.end);
          this.buffer = this.buffer.substring(rawCandidate.end);
          this.processToolContent(content, result);
          continue;
        }

        if (match && match.index !== undefined) {
          // Text before the tool call tag
          const textBefore = this.buffer.substring(0, match.index);
          // Once a tool call appears, hold the lead-in text.
          // OpenAI-compatible clients expect the whole assistant turn to be
          // a structured tool_calls message when tools are invoked.
          this.pendingLeadIn += textBefore;
          this.insideTool = true;
          this.currentOpenTag = match[0];
          this.buffer = this.buffer.substring(match.index + match[0].length);
          continue;
        } else {
          // No full open tag found. Check for partial at end.
          const partialCandidates = [
            findPartialToolOpenIndex(this.buffer),
            this.allowedToolNames.size ? findPartialInlineToolIndex(this.buffer) : -1,
          ].filter((idx) => idx >= 0);
          const partialIdx = partialCandidates.length ? Math.min(...partialCandidates) : -1;
          const flushIndex = partialIdx === -1 ? this.buffer.length : partialIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
            const inline = this.parseInlineToolSyntax(textToEmit);
            if (inline && inline.calls.length > 0) {
              if (this.emittedToolCallCount === 0 && inline.textBefore.trim()) {
                result.text += inline.textBefore;
              }
              result.toolCalls.push(...inline.calls);
              this.emittedToolCallCount += inline.calls.length;
              this.pendingLeadIn = '';
              this.buffer = textToEmit.substring(inline.consumedChars) + this.buffer.substring(flushIndex);
            } else {
              result.text += textToEmit;
              this.buffer = this.buffer.substring(flushIndex);
            }
          }
          break;
        }
      } else {
        // Inside tool: look for </tool_call>
        const lowerBuffer = this.buffer.toLowerCase();
        const endIdx = lowerBuffer.indexOf(TOOL_END);
        if (endIdx !== -1) {
          const content = this.buffer.substring(0, endIdx);
          this.buffer = this.buffer.substring(endIdx + TOOL_END.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
        } else {
          break; // Wait for more data
        }
      }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      // Stream ended with unclosed <tool_call>. Try to recover.
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        const recovered = this.tryRecoverToolCall(trimmed);
        if (recovered) {
          result.toolCalls.push(recovered);
          this.emittedToolCallCount++;
          this.pendingLeadIn = '';
        } else {
          // Recovery failed. Restore lead-in text if no tools were emitted.
          logger.warn('[parser] Dropping unrecoverable unclosed tool call at end of stream');
          if (this.shouldExposeMalformedToolContent() && this.emittedToolCallCount === 0) {
            result.text += this.pendingLeadIn + this.currentOpenTag + this.buffer;
          }
          this.pendingLeadIn = '';
        }
      } else {
        // Empty tool call block - restore lead-in
        if (this.shouldExposeMalformedToolContent() && this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
          result.text += this.pendingLeadIn;
        }
        this.pendingLeadIn = '';
      }
    } else {
      if (this.emittedToolCallCount === 0) {
        const rawCandidate = findRawToolJsonCandidate(this.buffer, this.allowedToolNames);
        if (
          rawCandidate
          && rawCandidate.start === 0
          && rawCandidate.end === null
          && !this.shouldExposeMalformedToolContent()
        ) {
          logger.warn('[parser] Dropping unrecoverable raw tool call at end of stream');
        } else {
          result.text += this.pendingLeadIn + this.buffer;
        }
      }
      this.pendingLeadIn = '';
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

  /**
   * Get any lead-in text that was captured before tool calls.
   * Useful for fallback content when tool calls fail to parse.
   */
  getPendingLeadIn(): string {
    return this.pendingLeadIn;
  }

  // ─── Internal Methods ──────────────────────────────────────────────────────

  private processToolContent(content: string, result: ParserResult): void {
    const t = content.trim();
    if (!t) {
      // Empty tool call - malformed. Restore lead-in if possible.
      logger.warn('[parser] Dropping empty tool call block');
      if (this.shouldExposeMalformedToolContent() && this.emittedToolCallCount === 0) {
        result.text += this.pendingLeadIn + this.currentOpenTag + TOOL_END;
      }
      this.pendingLeadIn = '';
      return;
    }

    // 1) Try Hermes-style XML <parameter> format first
    const xmlParsed = parseXmlParameterToolCall(t, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      const normalized = this.normalizeParsedToolCall({
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      if (normalized) {
        if (this.shouldEmitLeadInWithToolCall() && this.emittedToolCallCount === 0 && this.pendingLeadIn.length > 0) {
          result.text += this.pendingLeadIn;
        }
        result.toolCalls.push(normalized);
        this.emittedToolCallCount++;
      }
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
            if (this.shouldEmitLeadInWithToolCall() && this.emittedToolCallCount === 0 && this.pendingLeadIn.length > 0) {
              result.text += this.pendingLeadIn;
            }
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
      const tcs = this.parseToolContent(t);
      if (tcs.length > 0) {
        for (const tc of tcs) {
          // Check for tool name from opening tag attribute
          if (!tc.name || tc.name === '') {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          const normalized = this.normalizeParsedToolCall(tc);
          if (normalized) {
            if (this.shouldEmitLeadInWithToolCall() && this.emittedToolCallCount === 0 && this.pendingLeadIn.length > 0) {
              result.text += this.pendingLeadIn;
            }
            result.toolCalls.push(normalized);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = '';
        return;
      }
    }

    // 4) Tool call is malformed and unrecoverable.
    // Never leak internal XML to user-visible content.
    // Restore lead-in text if no tools were emitted.
    logger.warn('[parser] Dropping malformed tool call block', { 
      contentPreview: t.substring(0, 500), 
      hasName: t.includes('"name"') || t.includes('"tool"') || t.includes('tool_name'),
      hasArgs: t.includes('"arguments"') || t.includes('"args"') || t.includes('"parameters"') || t.includes('"input"'),
      first100Chars: t.substring(0, 100)
    });
    if (this.shouldExposeMalformedToolContent() && this.emittedToolCallCount === 0) {
      result.text += this.pendingLeadIn + this.currentOpenTag + content + TOOL_END;
    }
    this.pendingLeadIn = '';
  }

  private shouldEmitLeadInWithToolCall(): boolean {
    return this.allowedToolNames.size === 0;
  }

  private shouldExposeMalformedToolContent(): boolean {
    return this.allowedToolNames.size === 0;
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    // Try full parse first
    const xmlParsed = parseXmlParameterToolCall(block, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      const normalized = this.normalizeParsedToolCall({
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      if (normalized) return normalized;
    }

    // Try recoverable (unclosed parameters)
    const recovered = parseRecoverableXmlToolCall(block, this.currentOpenTag, this.tools);
    if (recovered) {
      return {
        id: `call_${uuidv4()}`,
        name: recovered.name,
        arguments: recovered.arguments,
      };
    }

    // Try JSON (single or multiple)
    const jsonParsed = this.parseToolContent(block);
    if (jsonParsed.length > 0) {
      const first = jsonParsed[0];
      const attrName = extractToolName(this.currentOpenTag, block);
      if (attrName && !first.name) first.name = attrName;
      const normalized = this.normalizeParsedToolCall(first);
      if (normalized) return normalized;
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
    } catch {}
    
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
        } catch {}
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

    return this.normalizeParsedToolCall({
      id: parsed.id || parsed.tool_call_id || `call_${uuidv4()}`,
      name,
      arguments: args,
    });
  }

  private parseInlineToolSyntax(text: string): { calls: ParsedToolCall[]; consumedChars: number; textBefore: string } | null {
    const calls: ParsedToolCall[] = [];
    const re = /\btool\s*:\s*([A-Za-z_][\w-]*)\s*\(([^()]*)\)/gi;
    let match: RegExpExecArray | null;
    let firstIndex = -1;
    let consumedChars = 0;

    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      if (!this.isAllowedToolName(name)) continue;
      const args = parseInlineArguments(match[2]);
      const normalized = this.normalizeParsedToolCall({
        id: `call_${uuidv4()}`,
        name,
        arguments: args,
      });
      if (!normalized) continue;
      if (firstIndex === -1) firstIndex = match.index;
      calls.push(normalized);
      consumedChars = re.lastIndex;
    }

    if (calls.length === 0 || firstIndex < 0) return null;
    return {
      calls,
      consumedChars,
      textBefore: text.substring(0, firstIndex),
    };
  }

  private refreshAllowedToolNames(): void {
    this.allowedToolNames = new Set(
      this.tools
        .map((tool: any) => {
          if (tool?.type === 'function') return tool.function?.name || tool.name;
          return tool?.function?.name || tool?.name;
        })
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0)
    );
  }

  private isAllowedToolName(name: string): boolean {
    if (!this.allowedToolNames.size) return true;
    return this.allowedToolNames.has(name);
  }

  private resolveAllowedToolName(name: string): string | null {
    if (!this.allowedToolNames.size) return name;
    if (this.allowedToolNames.has(name)) return name;

    const variants = [
      name.replace(/^[`*_~\s]+|[`*_~\s]+$/g, ''),
      name.replace(/^[^A-Za-z0-9_]+/, '').replace(/[^A-Za-z0-9_.-]+$/, ''),
    ].filter(Boolean);

    for (const variant of variants) {
      if (this.allowedToolNames.has(variant)) return variant;
    }

    const lowerName = name.toLowerCase();
    for (const allowed of this.allowedToolNames) {
      if (allowed.toLowerCase() === lowerName) return allowed;
      if (variants.some((variant) => allowed.toLowerCase() === variant.toLowerCase())) return allowed;
    }

    return null;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  private sanitizeArguments(value: unknown, depth = 0): Record<string, unknown> {
    if (!this.isPlainObject(value) || depth > 6) return {};

    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value)) {
      if (count >= 100) break;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          out[key] = child.slice(0, 100).map((item) => {
            if (this.isPlainObject(item)) return this.sanitizeArguments(item, depth + 1);
            if (Array.isArray(item)) return item.slice(0, 100);
            return item;
          });
        } else if (this.isPlainObject(child)) {
          out[key] = this.sanitizeArguments(child, depth + 1);
        } else {
          out[key] = JSON.parse(JSON.stringify(child));
        }
      } else {
        out[key] = child;
      }
      count++;
    }

    return out;
  }

  private normalizeParsedToolCall(call: ParsedToolCall | null): ParsedToolCall | null {
    if (!call || typeof call.name !== 'string' || !call.name.trim()) return null;

    const name = call.name.trim();
    const resolvedName = this.resolveAllowedToolName(name);
    if (!resolvedName) {
      const inferred = inferToolNameFromParameters(call.arguments, this.tools);
      if (!inferred || !this.isAllowedToolName(inferred)) {
        logger.warn('[parser] Dropping tool call with unknown tool name', { name });
        return null;
      }
      call.name = inferred;
    } else {
      call.name = resolvedName;
    }

    call.arguments = this.sanitizeArguments(call.arguments);
    return call;
  }
}
