/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 * Supports both JSON and Hermes-style XML <parameter> formats.
 */

import { v4 as uuidv4 } from "uuid";
import { robustParseJSON } from "../utils/json.ts";
import { logger, isToolcallDebugEnabled } from "../core/logger.js";
import type { ParsedToolCall } from "./types";
import type { FunctionToolDefinition } from "./types";

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

// ─── XML Helpers ───────────────────────────────────────────────────────────────

const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;
const TOOL_END = "</tool_call>";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

/**
 * Extract tool name from the opening tag attribute or a <name> child element.
 */
function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(
    /<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i,
  );
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return "";
}

/**
 * Infer tool name by matching parameter keys against tool definitions.
 * Only returns a name if exactly one tool matches all argument keys.
 */
function inferToolNameFromParameters(
  args: Record<string, unknown>,
  tools: FunctionToolDefinition[],
): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return "";

  const matches = tools.filter((tool) => {
    const fn =
      tool?.type === "function" ? tool.function : (tool as any)?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every((k) =>
      Object.prototype.hasOwnProperty.call(properties, k),
    );
  });

  if (matches.length === 1) {
    const fn =
      matches[0]?.type === "function"
        ? matches[0].function
        : (matches[0] as any)?.function;
    return fn?.name || "";
  }

  return "";
}

/**
 * Parse Hermes-style XML <parameter name="...">value</parameter> format.
 */
function parseXmlParameterToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[],
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};
  const parameterRe =
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName =
    extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
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
  tools: FunctionToolDefinition[],
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe =
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = closedParameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    lastClosedEnd = closedParameterRe.lastIndex;
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i,
  );
  if (unclosedMatch) {
    args[unclosedMatch[1]] = coerceParameterValue(unclosedMatch[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName =
    extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = "<tool_call>";

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  // Check if there's a partial opening tag like `<tool_call` without closing `>`
  const idx = lower.lastIndexOf("<tool_call");
  if (idx !== -1 && lower.indexOf(">", idx) === -1) return idx;

  // Check for partial prefix at end (e.g. `<tool`, `<tool_`, `<tool_c`)
  for (let i = 1; i < TOOL_START_LITERAL.length; i++) {
    if (lower.endsWith(TOOL_START_LITERAL.substring(0, i)))
      return buffer.length - i;
  }
  return -1;
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = "";
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private emittedToolCallCount = 0;
  private pendingLeadIn = "";
  private tools: FunctionToolDefinition[] = [];

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(tools: FunctionToolDefinition[] = []) {
    this.tools = tools;
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] StreamingToolParser initialized", {
        toolsCount: tools.length,
        toolNames: tools.map((t) => t.function?.name).filter(Boolean),
      });
    }
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: FunctionToolDefinition[]): void {
    this.tools = tools;
  }

  feed(chunk: string): ParserResult {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] feed() called", {
        chunkLength: chunk.length,
        chunkPreview: chunk.substring(0, 200),
        bufferLength: this.buffer.length,
        insideTool: this.insideTool,
        emittedToolCallCount: this.emittedToolCallCount,
      });
    }

    this.buffer += chunk;
    const result: ParserResult = { text: "", toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const match = this.buffer.match(TOOL_OPEN_RE);
        if (match && match.index !== undefined) {
          // Text before the tool call tag
          const textBefore = this.buffer.substring(0, match.index);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] tool_call open tag detected", {
              matchIndex: match.index,
              openTag: match[0],
              textBeforeLength: textBefore.length,
              textBeforePreview: textBefore.substring(0, 100),
            });
          }
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
          const partialIdx = findPartialToolOpenIndex(this.buffer);
          const flushIndex =
            partialIdx === -1 ? this.buffer.length : partialIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
            // Only emit as content if no tool calls have been emitted yet
            if (this.emittedToolCallCount === 0) {
              result.text += textToEmit;
            }
            this.buffer = this.buffer.substring(flushIndex);
          }
          if (isToolcallDebugEnabled() && partialIdx !== -1) {
            logger.debug(
              "[parser] partial tool_call tag detected at end of buffer",
              {
                partialIdx,
                partialContent: this.buffer.substring(partialIdx),
              },
            );
          }
          break;
        }
      } else {
        // Inside tool: look for </tool_call>
        const lowerBuffer = this.buffer.toLowerCase();
        const endIdx = lowerBuffer.indexOf(TOOL_END);
        if (endIdx !== -1) {
          const content = this.buffer.substring(0, endIdx);
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] tool_call close tag detected", {
              contentLength: content.length,
              contentPreview: content.substring(0, 300),
              remainingBufferLength:
                this.buffer.length - endIdx - TOOL_END.length,
            });
          }
          this.buffer = this.buffer.substring(endIdx + TOOL_END.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
        } else {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] waiting for more data inside tool_call", {
              bufferLength: this.buffer.length,
              bufferPreview: this.buffer.substring(0, 200),
            });
          }
          break; // Wait for more data
        }
      }
    }

    if (
      isToolcallDebugEnabled() &&
      (result.text || result.toolCalls.length > 0)
    ) {
      logger.debug("[parser] feed() result", {
        textLength: result.text.length,
        textPreview: result.text.substring(0, 100),
        toolCallsCount: result.toolCalls.length,
        toolCallNames: result.toolCalls.map((tc) => tc.name),
      });
    }

    return result;
  }

  flush(): ParserResult {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] flush() called", {
        bufferLength: this.buffer.length,
        bufferPreview: this.buffer.substring(0, 200),
        insideTool: this.insideTool,
        pendingLeadInLength: this.pendingLeadIn.length,
        emittedToolCallCount: this.emittedToolCallCount,
      });
    }

    const result: ParserResult = { text: "", toolCalls: [] };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      // Stream ended with unclosed <tool_call>. Try to recover.
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] flush: attempting recovery of unclosed tool_call",
            {
              trimmedLength: trimmed.length,
              trimmedPreview: trimmed.substring(0, 300),
            },
          );
        }
        const recovered = this.tryRecoverToolCall(trimmed);
        if (recovered) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[parser] flush: recovery successful", {
              name: recovered.name,
              arguments: recovered.arguments,
              id: recovered.id,
            });
          }
          result.toolCalls.push(recovered);
          this.emittedToolCallCount++;
          this.pendingLeadIn = "";
        } else {
          // Recovery failed. Restore lead-in text if no tools were emitted.
          logger.warn(
            "[parser] Dropping unrecoverable unclosed tool call at end of stream",
            {
              bufferPreview: trimmed.substring(0, 500),
            },
          );
          if (
            this.emittedToolCallCount === 0 &&
            this.pendingLeadIn.trim().length > 0
          ) {
            result.text += this.pendingLeadIn;
          }
          this.pendingLeadIn = "";
        }
      } else {
        // Empty tool call block - restore lead-in
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[parser] flush: empty tool call block, restoring lead-in",
          );
        }
        if (
          this.emittedToolCallCount === 0 &&
          this.pendingLeadIn.trim().length > 0
        ) {
          result.text += this.pendingLeadIn;
        }
        this.pendingLeadIn = "";
      }
    } else {
      if (this.emittedToolCallCount === 0) {
        result.text += this.buffer;
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] flush() result", {
        textLength: result.text.length,
        toolCallsCount: result.toolCalls.length,
        toolCallNames: result.toolCalls.map((tc) => tc.name),
        totalEmittedToolCalls: this.emittedToolCallCount,
      });
    }

    this.buffer = "";
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
      logger.warn("[parser] Dropping empty tool call block");
      if (
        this.emittedToolCallCount === 0 &&
        this.pendingLeadIn.trim().length > 0
      ) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = "";
      return;
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] processToolContent: analyzing content", {
        contentLength: t.length,
        contentPreview: t.substring(0, 300),
        startsWithBrace: t.startsWith("{"),
        startsWithBracket: t.startsWith("["),
        hasName: t.includes('"name"') || t.includes("<name>"),
        hasArgs:
          t.includes('"arguments"') ||
          t.includes('"args"') ||
          t.includes("<parameter"),
        openTag: this.currentOpenTag,
      });
    }

    // 1) Try Hermes-style XML <parameter> format first
    const xmlParsed = parseXmlParameterToolCall(
      t,
      this.currentOpenTag,
      this.tools,
    );
    if (xmlParsed) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: XML parameter format parsed successfully",
          {
            name: xmlParsed.name,
            arguments: xmlParsed.arguments,
            argsKeys: Object.keys(xmlParsed.arguments),
          },
        );
      }
      result.toolCalls.push({
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      this.emittedToolCallCount++;
      this.pendingLeadIn = "";
      return;
    }

    // 2) Try JSON array format
    if (t.startsWith("[")) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: attempting JSON array parse",
        );
      }
      try {
        const arr = JSON.parse(t);
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            if (isToolcallDebugEnabled()) {
              logger.debug("[parser] processToolContent: array item parsed", {
                name: tc.name,
                arguments: tc.arguments,
              });
            }
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = "";
        return;
      } catch (e) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[parser] processToolContent: JSON array parse failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        // Fall through to JSON object parsing
      }
    }

    // 3) Try JSON object format (single or multiple)
    if (t.startsWith("{") || t.includes('"name"')) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] processToolContent: attempting JSON object parse",
        );
      }
      const tcs = this.parseToolContent(t);
      if (tcs.length > 0) {
        for (const tc of tcs) {
          // Check for tool name from opening tag attribute
          if (!tc.name || tc.name === "") {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          if (tc.name) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[parser] processToolContent: JSON object parsed successfully",
                {
                  name: tc.name,
                  arguments: tc.arguments,
                  argsKeys: Object.keys(tc.arguments),
                },
              );
            }
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = "";
        return;
      }
    }

    // 4) Tool call is malformed and unrecoverable.
    // Never leak internal XML to user-visible content.
    // Restore lead-in text if no tools were emitted.
    logger.warn("[parser] Dropping malformed tool call block", {
      contentPreview: t.substring(0, 500),
      hasName:
        t.includes('"name"') || t.includes('"tool"') || t.includes("tool_name"),
      hasArgs:
        t.includes('"arguments"') ||
        t.includes('"args"') ||
        t.includes('"parameters"') ||
        t.includes('"input"'),
      first100Chars: t.substring(0, 100),
      contentLength: t.length,
    });
    if (
      this.emittedToolCallCount === 0 &&
      this.pendingLeadIn.trim().length > 0
    ) {
      result.text += this.pendingLeadIn;
    }
    this.pendingLeadIn = "";
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] tryRecoverToolCall: starting recovery attempts", {
        blockLength: block.length,
        blockPreview: block.substring(0, 300),
      });
    }

    // Try full parse first
    const xmlParsed = parseXmlParameterToolCall(
      block,
      this.currentOpenTag,
      this.tools,
    );
    if (xmlParsed) {
      if (isToolcallDebugEnabled()) {
        logger.debug("[parser] tryRecoverToolCall: full XML parse succeeded", {
          name: xmlParsed.name,
          arguments: xmlParsed.arguments,
        });
      }
      return {
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      };
    }

    // Try recoverable (unclosed parameters)
    const recovered = parseRecoverableXmlToolCall(
      block,
      this.currentOpenTag,
      this.tools,
    );
    if (recovered) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] tryRecoverToolCall: recoverable XML parse succeeded",
          {
            name: recovered.name,
            arguments: recovered.arguments,
          },
        );
      }
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
      if (first.name) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[parser] tryRecoverToolCall: JSON parse succeeded", {
            name: first.name,
            arguments: first.arguments,
          });
        }
        return first;
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] tryRecoverToolCall: all recovery attempts failed");
    }
    return null;
  }

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] parseToolContent: starting parse", {
        inputLength: str.length,
        inputPreview: str.substring(0, 200),
        hasNewlines: str.includes("\n"),
      });
    }

    // Try parsing as single JSON first
    try {
      const parsed = robustParseJSON(str);
      if (parsed && typeof parsed === "object") {
        const tc = this.parseToolCall(parsed);
        if (tc) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] parseToolContent: single JSON parse succeeded",
              {
                name: tc.name,
                arguments: tc.arguments,
              },
            );
          }
          calls.push(tc);
        }
      }
    } catch (e) {
      if (isToolcallDebugEnabled()) {
        logger.debug("[parser] parseToolContent: single JSON parse failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Always try line-by-line parsing for multi-JSON content (independent of single parse)
    if (str.includes("\n")) {
      const lines = str
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"));
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[parser] parseToolContent: attempting line-by-line parse",
          {
            candidateLines: lines.length,
          },
        );
      }
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") {
            const tc = this.parseToolCall(parsed);
            if (
              tc &&
              !calls.some(
                (c) =>
                  c.name === tc.name &&
                  JSON.stringify(c.arguments) === JSON.stringify(tc.arguments),
              )
            ) {
              if (isToolcallDebugEnabled()) {
                logger.debug(
                  "[parser] parseToolContent: line-by-line parse succeeded",
                  {
                    name: tc.name,
                    arguments: tc.arguments,
                  },
                );
              }
              calls.push(tc);
            }
          }
        } catch (e) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[parser] parseToolContent: line-by-line parse failed",
              {
                line: line.substring(0, 100),
                error: e instanceof Error ? e.message : String(e),
              },
            );
          }
        }
      }
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[parser] parseToolContent: result", {
        totalParsed: calls.length,
        names: calls.map((c) => c.name),
      });
    }

    return calls;
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== "object") return null;

    const name =
      parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== "string" || name.length === 0) return null;

    let args =
      parsed.arguments ||
      parsed.function?.arguments ||
      parsed.args ||
      parsed.parameters ||
      parsed.input ||
      {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (typeof args !== "object" || args === null) args = {};

    return {
      id: parsed.id || parsed.tool_call_id || `call_${uuidv4()}`,
      name,
      arguments: args,
    };
  }
}
