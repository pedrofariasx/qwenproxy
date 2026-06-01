/*
 * File: executor.ts
 * Project: qwenproxy
 * Execution loop for tool calling - agentic loop that handles
 * send -> tool calls -> execute -> re-send until completion
 */

import { v4 as uuidv4 } from "uuid";
import type { ParsedToolCall, ToolCallResult, ToolContext } from "./types";
import { SchemaValidationError } from "./schema";
import { registry } from "./registry";
import { robustParseJSON } from "../utils/json.ts";
import {
  logger,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
} from "../core/logger.js";

export interface ExecutionLoopConfig {
  maxTurns?: number;
  debug?: boolean;
}

export interface LoopTurnResult {
  toolCalls: ParsedToolCall[];
  toolResults: ToolCallResult[];
  content: string | null;
  finishReason: string | null;
  turn: number;
}

export type LLMSendFunction = (
  messages: unknown[],
  tools: unknown[] | undefined,
  model: string,
) => Promise<LLMResponse>;

export interface LLMResponse {
  content: string | null;
  toolCalls: ParsedToolCall[];
  finishReason: string;
}

const TOOL_START_TAG = "<" + "tool_call>";
const TOOL_END_TAG = "</" + "tool_call>";

export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  if (isToolcallDebugEnabled()) {
    logger.debug("[executor] parseToolCallsFromContent: starting", {
      contentLength: content.length,
      contentPreview: content.substring(0, 300),
    });
  }

  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = "";

  while (true) {
    const startIdx = remaining.indexOf(TOOL_START_TAG);
    if (startIdx === -1) {
      textContent += remaining;
      break;
    }

    textContent += remaining.substring(0, startIdx);

    const endIdx = remaining.indexOf(
      TOOL_END_TAG,
      startIdx + TOOL_START_TAG.length,
    );
    if (endIdx === -1) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[executor] parseToolCallsFromContent: unclosed tool_call tag",
          {
            startIdx,
            remainingLength: remaining.length,
          },
        );
      }
      textContent += remaining.substring(startIdx);
      break;
    }

    const jsonStr = remaining
      .substring(startIdx + TOOL_START_TAG.length, endIdx)
      .trim();

    if (isToolcallDebugEnabled()) {
      logger.debug("[executor] parseToolCallsFromContent: found tool_call", {
        jsonStrPreview: jsonStr.substring(0, 200),
      });
    }

    try {
      const parsed = robustParseJSON(jsonStr);
      if (!parsed) throw new Error("Failed to parse JSON");

      const toolCall: ParsedToolCall = {
        id: "call_" + uuidv4(),
        name: parsed.name || "",
        arguments: parsed.arguments
          ? typeof parsed.arguments === "string"
            ? JSON.parse(parsed.arguments)
            : parsed.arguments
          : (() => {
              const { name, ...rest } = parsed;
              return rest;
            })(),
      };

      if (isToolcallDebugEnabled()) {
        logger.debug("[executor] parseToolCallsFromContent: toolcall parsed", {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          argsKeys: Object.keys(toolCall.arguments),
        });
      }

      toolCalls.push(toolCall);
    } catch (e) {
      if (isToolcallDebugEnabled()) {
        logger.debug(
          "[executor] parseToolCallsFromContent: parse failed, restoring tags",
          {
            error: e instanceof Error ? e.message : String(e),
            jsonStrPreview: jsonStr.substring(0, 200),
          },
        );
      }
      textContent += TOOL_START_TAG + jsonStr + TOOL_END_TAG;
    }

    remaining = remaining.substring(endIdx + TOOL_END_TAG.length);
  }

  if (isToolcallDebugEnabled()) {
    logger.debug("[executor] parseToolCallsFromContent: result", {
      toolCallsCount: toolCalls.length,
      toolCallNames: toolCalls.map((tc) => tc.name),
      textContentLength: textContent.length,
    });
  }

  return { textContent: textContent.trim(), toolCalls };
}

export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext,
): Promise<ToolCallResult[]> {
  if (isToolcallDebugEnabled()) {
    logger.debug("[executor] executeToolCalls: starting", {
      count: toolCalls.length,
      tools: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        argsKeys: Object.keys(tc.arguments),
      })),
    });
  }

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const startTime = Date.now();
      try {
        if (!registry.has(tc.name)) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[executor] executeToolCalls: unknown tool", {
              name: tc.name,
              availableTools: registry.listNames(),
            });
          }
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
            isError: true,
          };
        }

        if (isToolcallDebugEnabled()) {
          logger.debug("[executor] executeToolCalls: executing tool", {
            name: tc.name,
            id: tc.id,
            arguments: tc.arguments,
          });
        }

        const result = await registry.execute(tc.name, tc.arguments, context);
        const duration = Date.now() - startTime;

        if (isToolcallDebugEnabled()) {
          logger.debug("[executor] executeToolCalls: tool executed", {
            name: tc.name,
            id: tc.id,
            duration,
            resultPreview:
              typeof result === "string"
                ? result.substring(0, 200)
                : JSON.stringify(result).substring(0, 200),
            isError: false,
          });
        }

        return {
          toolCallId: tc.id,
          name: tc.name,
          result,
          isError: false,
        };
      } catch (err: unknown) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        const isValidation = err instanceof SchemaValidationError;

        if (isToolcallErrorDebugEnabled()) {
          logger.debug("[executor] executeToolCalls: tool failed", {
            name: tc.name,
            id: tc.id,
            duration,
            error: message,
            isValidation,
            path: isValidation
              ? (err as SchemaValidationError).path
              : undefined,
            arguments: tc.arguments,
          });
        }

        return {
          toolCallId: tc.id,
          name: tc.name,
          result: JSON.stringify({
            error: isValidation
              ? "Schema validation failed"
              : "Tool execution error",
            details: message,
            ...(isValidation
              ? { path: (err as SchemaValidationError).path }
              : {}),
          }),
          isError: true,
        };
      }
    }),
  );

  if (isToolcallDebugEnabled()) {
    logger.debug("[executor] executeToolCalls: all done", {
      total: results.length,
      errors: results.filter((r) => r.isError).length,
      results: results.map((r) => ({
        name: r.name,
        isError: r.isError,
        resultPreview:
          typeof r.result === "string" ? r.result.substring(0, 100) : "",
      })),
    });
  }

  return results;
}

function buildToolMessage(result: ToolCallResult): Record<string, unknown> {
  return {
    role: "tool",
    tool_call_id: result.toolCallId,
    content: result.result,
  };
}

function buildAssistantToolCallMessage(
  content: string | null,
  toolCalls: ParsedToolCall[],
): Record<string, unknown> {
  const msg = {
    role: "assistant",
    content: content || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments),
      },
    })),
  };

  if (isToolcallDebugEnabled()) {
    logger.debug("[executor] buildAssistantToolCallMessage", {
      contentLength: content?.length || 0,
      toolCallsCount: toolCalls.length,
      toolCallNames: toolCalls.map((tc) => tc.name),
    });
  }

  return msg;
}

export async function runExecutionLoop(
  sendToLLM: LLMSendFunction,
  messages: unknown[],
  model: string,
  config: ExecutionLoopConfig = {},
): Promise<string> {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? isToolcallDebugEnabled();

  if (debug) {
    logger.debug("[executor] runExecutionLoop: starting", {
      maxTurns,
      model,
      messagesCount: messages.length,
      registeredTools: registry.listNames(),
    });
  }

  const tools =
    registry.listNames().length > 0 ? registry.toOpenAITools() : undefined;

  if (debug) {
    logger.debug("[executor] runExecutionLoop: tools available", {
      toolsCount: tools?.length || 0,
      toolNames: tools?.map((t: any) => t.function?.name) || [],
    });
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (debug) {
      logger.debug(
        `[executor] runExecutionLoop: turn ${turn + 1}/${maxTurns}`,
        {
          messagesCount: messages.length,
          lastMessageRole: (messages[messages.length - 1] as any)?.role,
        },
      );
    }

    const response = await sendToLLM(messages, tools, model);

    if (debug) {
      logger.debug("[executor] runExecutionLoop: LLM response received", {
        contentLength: response.content?.length || 0,
        contentPreview: response.content?.substring(0, 200) || "",
        structuredToolCallsCount: response.toolCalls?.length || 0,
        finishReason: response.finishReason,
      });
    }

    const hasStructuredToolCalls =
      response.toolCalls && response.toolCalls.length > 0;
    let parsedFromContent: {
      textContent: string;
      toolCalls: ParsedToolCall[];
    } | null = null;

    if (!hasStructuredToolCalls && response.content) {
      if (debug) {
        logger.debug(
          "[executor] runExecutionLoop: no structured tool calls, parsing content",
        );
      }
      parsedFromContent = parseToolCallsFromContent(response.content);
    }

    const effectiveToolCalls = hasStructuredToolCalls
      ? response.toolCalls
      : parsedFromContent?.toolCalls || [];

    const effectiveContent = parsedFromContent
      ? parsedFromContent.textContent
      : response.content;

    if (effectiveToolCalls.length === 0) {
      if (debug) {
        logger.debug(
          "[executor] runExecutionLoop: no tool calls, loop complete",
          {
            contentLength: effectiveContent?.length || 0,
            contentPreview: effectiveContent?.substring(0, 200) || "",
            turnsCompleted: turn + 1,
          },
        );
      }
      return effectiveContent || "";
    }

    const context: ToolContext = {
      messages,
      turn,
      model,
    };

    if (debug) {
      logger.debug(
        `[executor] runExecutionLoop: executing ${effectiveToolCalls.length} tool calls`,
        {
          toolCalls: effectiveToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsKeys: Object.keys(tc.arguments),
          })),
        },
      );
    }

    const toolResults = await executeToolCalls(effectiveToolCalls, context);

    messages.push(
      buildAssistantToolCallMessage(effectiveContent, effectiveToolCalls),
    );

    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }

    if (debug) {
      logger.debug(
        "[executor] runExecutionLoop: tool results added to messages",
        {
          resultsCount: toolResults.length,
          results: toolResults.map((r) => ({
            name: r.name,
            isError: r.isError,
            resultPreview:
              typeof r.result === "string" ? r.result.substring(0, 100) : "",
          })),
          totalMessages: messages.length,
        },
      );
    }
  }

  throw new Error(
    `Execution loop exceeded maximum turns (${maxTurns}). The agent may be stuck in a cycle.`,
  );
}
