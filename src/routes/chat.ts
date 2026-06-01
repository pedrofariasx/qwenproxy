/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import {
  createQwenStream,
  updateSessionParent,
  QwenSessionExpiredError,
  clearSessionState,
  clearAllSessionsForAccount,
} from "../services/qwen.ts";
import { OpenAIRequest } from "../utils/types.ts";
import { StreamingToolParser } from "../tools/parser.ts";
import { RetryableQwenStreamError } from "../services/qwen.ts";
import { Mutex } from "../services/playwright.ts";
import { getModelContextWindow } from "../core/model-registry.js";
import {
  truncateMessages,
  estimateTokenCount,
} from "../utils/context-truncation.ts";
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  getAccountCooldownInfo,
} from "../core/account-manager.ts";
import {
  registerStream,
  removeStream,
  getStream,
  getStreamBySessionId,
  updateStreamTargetResponseId,
} from "../core/stream-registry.ts";
import { metrics } from "../core/metrics.js";
import {
  logger,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
} from "../core/logger.js";

const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(
  oldStr: string,
  newStr: string,
): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: "", matchedContent: oldStr };
  }

  // Heuristic to detect if newStr is cumulative or incremental:
  // If newStr is cumulative, it should share a common prefix with oldStr.
  // Limit scan window to avoid O(n) on very long cumulative content
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  while (
    commonPrefixLen < maxLen &&
    oldStr[commonPrefixLen] === newStr[commonPrefixLen]
  ) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr,
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  // We avoid fallback search/sliding overlap checks which cause disastrous false-positive
  // corruptions on incremental streams with repetitive code/words (like "import {", "const", etc.).
  return {
    delta: newStr,
    matchedContent: oldStr + newStr,
  };
}

function parseQwenErrorPayload(
  raw: string,
): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details =
        payload.data?.details || payload.message || "Qwen returned an error";
      const wait =
        payload.data?.num !== undefined
          ? ` Wait about ${payload.data.num} hour(s) before trying again.`
          : "";
      const status =
        code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return {
        message: `Qwen upstream error: ${code}: ${details}.${wait}`,
        status,
      };
    }
    if (payload && payload.error) {
      const msg =
        typeof payload.error === "string"
          ? payload.error
          : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return {
      message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`,
      status: 502,
    };
  }

  return null;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    // Extract the prompt
    let prompt = "";
    const messages = body.messages || [];
    let systemPrompt = "";

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = "";
      if (Array.isArray(msg.content)) {
        contentStr = msg.content
          .map((c: any) => c.text || JSON.stringify(c))
          .join("\n");
      } else if (typeof msg.content === "object" && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || "";
      }

      if (msg.role === "system") {
        systemPrompt += (contentStr || "") + "\n\n";
      } else if (msg.role === "user") {
        prompt += `User: ${contentStr || ""}\n\n`;
      } else if (msg.role === "assistant") {
        let assistantContent = contentStr || "";
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] processing assistant tool_calls in history", {
              messageIndex: i,
              toolCallsCount: msg.tool_calls.length,
              toolCallNames: msg.tool_calls.map((tc: any) => tc.function?.name),
            });
          }
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments;
            let parsedArgs: any = {};
            if (typeof args === "string") {
              try {
                parsedArgs = JSON.parse(args);
              } catch {
                parsedArgs = {};
              }
            } else if (args && typeof args === "object") {
              parsedArgs = args;
            }
            const payload = {
              name: tc.function?.name,
              arguments: parsedArgs,
            };
            const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
            assistantContent = assistantContent
              ? assistantContent + toolCallStr
              : toolCallStr.trim();

            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] tool_call serialized to prompt", {
                toolName: tc.function?.name,
                toolCallId: tc.id,
                argsKeys: Object.keys(parsedArgs),
              });
            }
          }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === "tool" || msg.role === "function") {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(
                (tc) => tc.id === msg.tool_call_id,
              );
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] processing tool response in history", {
            messageIndex: i,
            toolName,
            toolCallId: msg.tool_call_id,
            contentLength: contentStr.length,
            contentPreview: contentStr.substring(0, 200),
          });
        }
        prompt += `Tool Response (${toolName || "tool"}): ${contentStr || ""}\n\n`;
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (
      bodyAny.tools &&
      Array.isArray(bodyAny.tools) &&
      bodyAny.tools.length > 0
    ) {
      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] tools provided in request", {
          toolsCount: bodyAny.tools.length,
          toolNames: bodyAny.tools.map((t: any) =>
            t.type === "function" ? t.function?.name : t.name,
          ),
          toolChoice: bodyAny.tool_choice || "none",
        });
      }

      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === "function") {
          return {
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters,
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);

      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`;

      if (
        bodyAny.tool_choice &&
        typeof bodyAny.tool_choice === "object" &&
        bodyAny.tool_choice.function
      ) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] forced tool_choice", { forcedTool });
        }
      }
    }

    const modelId = body.model.replace("-no-thinking", "");
    const modelContextWindow = getModelContextWindow(modelId);
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(
        messages,
        modelContextWindow,
        systemPrompt,
      );
      finalPrompt = truncated
        .map(
          (m) =>
            `${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role}: ${m.content}`,
        )
        .join("\n\n");
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    const isThinkingModel = !body.model.includes("no-thinking");

    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some((m) => m.role === "assistant");

    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = "";
    let releaseChatLock: (() => void) | undefined;
    const completionId = "chatcmpl-" + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== "global") {
        console.log(
          `[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`,
        );
        account = getNextAvailableAccount(accountId);
        continue;
      }

      console.log(
        `[Chat] Routing request to account: ${accountEmail} (${accountId})`,
      );

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] account selected", {
          accountId,
          accountEmail,
          isNewSession,
          isThinkingModel,
          promptLength: finalPrompt.length,
        });
      }

      const accountMutex = getAccountMutex(accountId);
      releaseChatLock = await accountMutex.acquire();

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] account lock acquired", {
          accountId,
          accountEmail,
        });
      }

      try {
        let retries = 3;
        let retryDelay = 500;
        let success = false;

        while (retries > 0) {
          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              body.model,
              isNewSession ? null : undefined,
              accountId === "global" ? undefined : accountId,
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: "",
              headers: result.headers,
            });
            success = true;

            if (isToolcallDebugEnabled()) {
              logger.debug("[chat] stream created successfully", {
                accountId,
                accountEmail,
                uiSessionId,
                completionId,
              });
            }

            break;
          } catch (err: any) {
            retries--;

            if (err.name === "QwenSessionExpiredError") {
              console.warn(
                `[Chat] Session expired for ${accountEmail} (${accountId}). Attempting re-login...`,
              );
              try {
                const { initPlaywrightForAccount } =
                  await import("../services/playwright.ts");
                const { getAccountCredentials } =
                  await import("../core/accounts.ts");
                const creds = getAccountCredentials(accountId);
                if (creds) {
                  await initPlaywrightForAccount(creds, true);
                  console.log(
                    `[Chat] Re-login successful for ${accountEmail}. Retrying...`,
                  );
                  continue;
                }
              } catch (reLoginErr: any) {
                console.error(
                  `[Chat] Re-login failed for ${accountEmail}: ${reLoginErr.message}`,
                );
              }
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            if (
              err.upstreamCode === "RateLimited" ||
              err.upstreamStatus === 429
            ) {
              const hourHint = err.message?.match(/Wait about (\d+) hour/);
              const cooldownMs = hourHint
                ? parseInt(hourHint[1]) * 60 * 60 * 1000
                : undefined;
              markAccountRateLimited(accountId, cooldownMs, "RateLimited");
              console.warn(
                `[Chat] Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`,
              );
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            if (retries === 0) {
              if (err.upstreamStatus && err.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, "ServerError");
                console.warn(
                  `[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`,
                );
              }

              // Clear session state when "chat is in progress" persists
              if (
                err instanceof RetryableQwenStreamError ||
                err.message?.includes("in progress")
              ) {
                console.warn(
                  `[Chat] Clearing session state for ${accountEmail} (${accountId}) due to persistent 'chat in progress'`,
                );
                clearAllSessionsForAccount(accountId);
              }

              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            let useDelay = retryDelay;
            if (
              err instanceof RetryableQwenStreamError &&
              err.retryAfterMs !== undefined
            ) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable =
              err instanceof RetryableQwenStreamError ||
              err.message?.includes("in progress") ||
              err.message?.includes("Bad_Request");
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            console.warn(
              `[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`,
            );
            await new Promise((r) => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] account failed, rotating", {
            accountId,
            accountEmail,
            triedAccounts: Array.from(triedAccountIds),
          });
        }

        releaseChatLock = undefined;
        account = getNextAvailableAccount(accountId);
        continue;
      } catch (err: any) {
        releaseChatLock?.();
        releaseChatLock = undefined;
        lastError = err;
        account = getNextAvailableAccount(accountId);
      }
    }

    if (!stream) {
      removeStream(completionId);
      throw lastError || new Error("All accounts failed");
    }

    if (!isStream) {
      try {
        const reader = stream!.getReader();
        const decoder = new TextDecoder();

        let currentThoughtIndex = 0;
        let reasoningBuffer = "";
        let lastFullContent = "";
        let targetResponseId: string | null = null;
        const toolParser = new StreamingToolParser(bodyAny.tools || []);
        const toolCallsOut: any[] = [];
        let buffer = "";
        let completionTokens = 0;
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(dataStr);

              if (
                chunk["response.created"] &&
                chunk["response.created"].response_id
              ) {
                if (!targetResponseId) {
                  targetResponseId = chunk["response.created"].response_id;
                }
                updateSessionParent(
                  uiSessionId,
                  chunk["response.created"].response_id,
                );
              } else if (chunk.response_id && !targetResponseId) {
                targetResponseId = chunk.response_id;
                updateSessionParent(uiSessionId, chunk.response_id);
              }

              if (chunk.usage) {
                if (chunk.usage.output_tokens)
                  completionTokens = chunk.usage.output_tokens;
                if (chunk.usage.input_tokens)
                  promptTokens = chunk.usage.input_tokens;
              }

              let vStr = "";
              let foundStr = false;
              let isThinkingChunk = false;

              if (
                chunk.choices &&
                chunk.choices[0] &&
                chunk.choices[0].delta &&
                (targetResponseId === null ||
                  chunk.response_id === targetResponseId)
              ) {
                const delta = chunk.choices[0].delta;

                if (delta.phase === "thinking_summary") {
                  isThinkingChunk = true;
                  if (
                    delta.extra &&
                    delta.extra.summary_thought &&
                    delta.extra.summary_thought.content
                  ) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join("\n");
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === "answer") {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || "";
                    const result = getIncrementalDelta(
                      lastFullContent,
                      newContent,
                    );
                    vStr = result.delta;
                    if (vStr) {
                      lastFullContent = result.matchedContent;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== "") {
                if (vStr === "FINISHED") continue;
                if (isThinkingChunk) {
                  reasoningBuffer += vStr;
                } else {
                  const { text, toolCalls } = toolParser.feed(vStr);
                  if (
                    isToolcallDebugEnabled() &&
                    (text || toolCalls.length > 0)
                  ) {
                    logger.debug("[chat] non-stream: parser feed result", {
                      textLength: text.length,
                      textPreview: text.substring(0, 100),
                      toolCallsCount: toolCalls.length,
                      toolCallNames: toolCalls.map((tc) => tc.name),
                    });
                  }
                  for (const tc of toolCalls) {
                    toolCallsOut.push({
                      id: tc.id,
                      type: "function",
                      function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                      },
                    });

                    if (isToolcallDebugEnabled()) {
                      logger.debug("[chat] non-stream: tool_call collected", {
                        id: tc.id,
                        name: tc.name,
                        argsKeys: Object.keys(tc.arguments),
                        totalCollected: toolCallsOut.length,
                      });
                    }
                  }
                }
              }
            } catch (e) {
              // parse error, ignore partial chunk
            }
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          removeStream(completionId);
          releaseChatLock?.();
          return c.json(
            { error: { message: upstreamError.message } },
            upstreamError.status as any,
          );
        }

        const { text: remainingText, toolCalls: remainingToolCalls } =
          toolParser.flush();

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: parser flush result", {
            remainingTextLength: remainingText?.length || 0,
            remainingToolCallsCount: remainingToolCalls.length,
            remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
          });
        }

        if (remainingText) {
          lastFullContent += remainingText;
        }
        for (const tc of remainingToolCalls) {
          toolCallsOut.push({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          });
        }

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: final toolcall summary", {
            totalToolCalls: toolCallsOut.length,
            toolCallNames: toolCallsOut.map((tc: any) => tc.function?.name),
            contentLength: lastFullContent.length,
            hasReasoning: !!reasoningBuffer,
          });
        }

        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: 0 },
        };
        const message: any = {
          role: "assistant",
          content: toolCallsOut.length ? null : lastFullContent,
        };
        if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
        if (toolCallsOut.length) {
          toolCallsOut.forEach((tc, idx) => {
            tc.index = idx;
          });
          message.tool_calls = toolCallsOut;
        }

        const finishReason = toolCallsOut.length ? "tool_calls" : "stop";

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: sending response", {
            completionId,
            finishReason,
            totalToolCalls: toolCallsOut.length,
            contentLength: message.content?.length || 0,
            hasReasoning: !!message.reasoning_content,
            usage,
          });
        }

        return c.json({
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message,
              logprobs: null,
              finish_reason: finishReason,
            },
          ],
          usage,
        });
      } finally {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: cleanup", { completionId });
        }
        releaseChatLock?.();
        removeStream(completionId);
      }
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      let clientDisconnected = false;

      // Detect client disconnection
      const abortHandler = async () => {
        if (clientDisconnected) return;
        clientDisconnected = true;

        console.log(
          `[Chat] Client disconnected for ${completionId}, stopping Qwen generation...`,
        );

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: client disconnected", {
            completionId,
            uiSessionId,
          });
        }

        // Stop generation on Qwen side
        try {
          const streamData = getStream(completionId);
          if (streamData && uiSessionId) {
            const targetResponseId = streamData.targetResponseId;
            if (targetResponseId) {
              console.log(
                `[Chat] Calling Qwen stop for session=${uiSessionId}, response=${targetResponseId}`,
              );
              await fetch(
                `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${uiSessionId}`,
                {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Cookie: streamData.headers.cookie,
                    Origin: "https://chat.qwen.ai",
                    Referer: `https://chat.qwen.ai/c/${uiSessionId}`,
                    "User-Agent": streamData.headers["user-agent"],
                    "X-Request-Id": uuidv4(),
                    "bx-ua": streamData.headers["bx-ua"],
                    "bx-umidtoken": streamData.headers["bx-umidtoken"],
                    "bx-v": streamData.headers["bx-v"],
                  },
                  body: JSON.stringify({
                    chat_id: uiSessionId,
                    response_id: targetResponseId,
                  }),
                },
              ).catch((err) => {
                console.error(`[Chat] Error calling Qwen stop: ${err.message}`);
              });
            } else {
              console.log(
                `[Chat] No targetResponseId yet for ${completionId}, skipping Qwen stop`,
              );
            }
          }

          // Abort the local stream (catch AbortError gracefully)
          try {
            streamData?.abortController.abort();
          } catch (abortErr: any) {
            // Ignore AbortError - this is expected when aborting
            if (abortErr.name !== "AbortError") {
              console.error(
                `[Chat] Error aborting stream: ${abortErr.message}`,
              );
            }
          }
        } catch (err: any) {
          console.error(
            `[Chat] Error during disconnect cleanup: ${err.message}`,
          );
        }

        // Clean up
        clearInterval(heartbeatInterval);
        removeStream(completionId);
        releaseChatLock?.();
      };

      // Listen for client disconnect via the request's close event
      c.req.raw.signal.addEventListener("abort", abortHandler);

      try {
        // Send heartbeat to prevent Cloudflare 524 timeout
        await streamWriter.write(": heartbeat\n\n");

        // Set up a periodic heartbeat to keep the connection alive during long thinking phases
        heartbeatInterval = setInterval(async () => {
          try {
            if (!clientDisconnected) {
              await streamWriter.write(": keep-alive\n\n");
            }
          } catch (e) {
            clearInterval(heartbeatInterval);
          }
        }, 15000); // Every 15 seconds

        const writeEvent = async (data: any) => {
          await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const makeChoice = (
          delta: any,
          finishReason: string | null = null,
        ) => ({
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finishReason,
        });

        // Send initial chunk
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ role: "assistant", content: "" })],
        });

        const reader = stream.getReader();
        const decoder = new TextDecoder();

        let currentThoughtIndex = 0;

        let reasoningBuffer = "";
        let lastFullContent = "";
        let targetResponseId: string | null = null;
        const toolParser = new StreamingToolParser(bodyAny.tools || []);

        let buffer = "";
        let completionTokens = 0;
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);

        while (true) {
          // Check if client disconnected
          if (clientDisconnected) {
            if (isToolcallDebugEnabled()) {
              logger.debug(
                "[chat] stream: breaking loop - client disconnected",
              );
            }
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const dataStr = trimmed.slice(6);
            if (dataStr === "[DONE]") {
              if (!clientDisconnected) {
                await streamWriter.write("data: [DONE]\n\n");
              }
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr);

              // Extract response_id for session tracking and target filtering
              if (
                chunk["response.created"] &&
                chunk["response.created"].response_id
              ) {
                if (!targetResponseId) {
                  targetResponseId = chunk["response.created"].response_id;
                  // Update stream registry with target response ID
                  if (targetResponseId) {
                    updateStreamTargetResponseId(
                      completionId,
                      targetResponseId,
                    );
                  }
                }
                updateSessionParent(
                  uiSessionId,
                  chunk["response.created"].response_id,
                );
              } else if (chunk.response_id && !targetResponseId) {
                targetResponseId = chunk.response_id;
                // Update stream registry with target response ID
                if (targetResponseId) {
                  updateStreamTargetResponseId(completionId, targetResponseId);
                }
                updateSessionParent(uiSessionId, chunk.response_id);
              }

              if (chunk.usage) {
                if (chunk.usage.output_tokens)
                  completionTokens = chunk.usage.output_tokens;
                if (chunk.usage.input_tokens)
                  promptTokens = chunk.usage.input_tokens;
              }

              let vStr = "";
              let foundStr = false;
              let isThinkingChunk = false;

              if (
                chunk.choices &&
                chunk.choices[0] &&
                chunk.choices[0].delta &&
                (targetResponseId === null ||
                  chunk.response_id === targetResponseId)
              ) {
                const delta = chunk.choices[0].delta;

                if (delta.phase === "thinking_summary") {
                  isThinkingChunk = true;
                  if (
                    delta.extra &&
                    delta.extra.summary_thought &&
                    delta.extra.summary_thought.content
                  ) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join("\n");
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === "answer") {
                  isThinkingChunk = false;
                  if (delta.content !== undefined) {
                    const newContent = delta.content || "";
                    const result = getIncrementalDelta(
                      lastFullContent,
                      newContent,
                    );
                    vStr = result.delta;
                    if (vStr) {
                      lastFullContent = result.matchedContent;
                      foundStr = true;
                    }
                  }
                }
              }

              if (foundStr && vStr !== "") {
                if (vStr === "FINISHED") continue;

                if (isThinkingChunk) {
                  reasoningBuffer += vStr;
                  await writeEvent({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ reasoning_content: vStr })],
                  });
                } else {
                  const { text, toolCalls } = toolParser.feed(vStr);

                  if (
                    isToolcallDebugEnabled() &&
                    (text || toolCalls.length > 0)
                  ) {
                    logger.debug("[chat] stream: parser feed result", {
                      textLength: text.length,
                      textPreview: text.substring(0, 100),
                      toolCallsCount: toolCalls.length,
                      toolCallNames: toolCalls.map((tc) => tc.name),
                    });
                  }

                  if (text) {
                    await writeEvent({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ content: text })],
                    });
                  }

                  for (const tc of toolCalls) {
                    if (isToolcallDebugEnabled()) {
                      logger.debug("[chat] stream: emitting tool_call chunk", {
                        id: tc.id,
                        name: tc.name,
                        argsKeys: Object.keys(tc.arguments),
                        index:
                          toolParser.getEmittedToolCallCount() -
                          toolCalls.length +
                          toolCalls.indexOf(tc),
                      });
                    }

                    await writeEvent({
                      id: completionId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [
                        makeChoice({
                          tool_calls: [
                            {
                              index:
                                toolParser.getEmittedToolCallCount() -
                                toolCalls.length +
                                toolCalls.indexOf(tc),
                              id: tc.id,
                              type: "function",
                              function: {
                                name: tc.name,
                                arguments: JSON.stringify(tc.arguments),
                              },
                            },
                          ],
                        }),
                      ],
                    });
                  }
                }
              }
            } catch (e) {
              // parse error, ignore partial chunk
            }
          }
        }

        const upstreamError = parseQwenErrorPayload(buffer);
        if (upstreamError) {
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: upstreamError.message })],
          });
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({}, "stop")],
          });
          await streamWriter.write("data: [DONE]\n\n");
          return;
        }

        // Flush tool parser
        const { text: remainingText, toolCalls: remainingToolCalls } =
          toolParser.flush();

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: parser flush result", {
            remainingTextLength: remainingText?.length || 0,
            remainingToolCallsCount: remainingToolCalls.length,
            remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
            totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
          });
        }

        if (remainingText) {
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: remainingText })],
          });
        }
        for (const tc of remainingToolCalls) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: emitting flushed tool_call chunk", {
              id: tc.id,
              name: tc.name,
              argsKeys: Object.keys(tc.arguments),
              index:
                toolParser.getEmittedToolCallCount() -
                remainingToolCalls.length +
                remainingToolCalls.indexOf(tc),
            });
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index:
                      toolParser.getEmittedToolCallCount() -
                      remainingToolCalls.length +
                      remainingToolCalls.indexOf(tc),
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  },
                ],
              }),
            ],
          });
        }

        // Send finish reason
        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: 0 },
        };

        const finalFinishReason =
          toolParser.getEmittedToolCallCount() > 0 ? "tool_calls" : "stop";

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending finish reason", {
            finishReason: finalFinishReason,
            totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
            usage,
            includeUsage: body.stream_options?.include_usage,
          });
        }

        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, finalFinishReason)],
          ...(body.stream_options?.include_usage ? {} : { usage }),
        });

        if (body.stream_options?.include_usage) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: sending usage event", { usage });
          }
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [],
            usage,
          });
        }

        // Only send [DONE] if client is still connected
        if (!clientDisconnected) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: sending [DONE]");
          }
          await streamWriter.write("data: [DONE]\n\n");

          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: completed successfully", {
              completionId,
              totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
              finishReason: finalFinishReason,
            });
          }
        } else {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[chat] stream: skipped [DONE] - client already disconnected",
            );
          }
        }
      } finally {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: cleanup started", {
            completionId,
            clientDisconnected,
          });
        }

        // Remove the abort listener
        c.req.raw.signal.removeEventListener("abort", abortHandler);

        clearInterval(heartbeatInterval);
        removeStream(completionId);
        releaseChatLock?.();

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: cleanup completed", {
            completionId,
          });
        }
      }
    });
  } catch (err: any) {
    console.error("Error in chatCompletions:", err);
    const status = err.upstreamStatus || 500;
    if (status >= 500) {
      metrics.increment("requests.errors");
    }
    return c.json({ error: { message: err.message } }, status);
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: "chat_id and response_id are required" }, 400);
    }

    const stream = getStreamBySessionId(chat_id) || getStream(chat_id);
    if (!stream) {
      return c.json({ error: "Stream not found" }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: "response_id mismatch" }, 400);
    }

    const stopResponse = await fetch(
      `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "pt-BR,pt;q=0.9",
          "Content-Type": "application/json",
          Cookie: stream.headers.cookie,
          Origin: "https://chat.qwen.ai",
          Referer: `https://chat.qwen.ai/c/${chat_id}`,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "User-Agent": stream.headers["user-agent"],
          "X-Request-Id": uuidv4(),
          "bx-ua": stream.headers["bx-ua"],
          "bx-umidtoken": stream.headers["bx-umidtoken"],
          "bx-v": stream.headers["bx-v"],
        },
        body: JSON.stringify({ chat_id, response_id }),
      },
    );

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(
        `[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`,
      );
      return c.json(
        { error: "Failed to stop generation" },
        stopResponse.status as any,
      );
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error("Error in chatCompletionsStop:", err);
    return c.json({ error: err.message }, 500);
  }
}
