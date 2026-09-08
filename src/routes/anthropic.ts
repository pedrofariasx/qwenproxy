import type { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import crypto from "crypto";
import type { OpenAIRequest } from "../utils/types.js";
import { createQwenStream } from "../services/qwen.js";
import { getNextAccount, markAccountRateLimited, releaseAccountInUse } from "../core/account-manager.js";
import { loadAccounts } from "../core/accounts.js";
import { registerStream, removeStream, abortStream } from "../core/stream-registry.js";
import { checkUserRateLimit, tryAcquireUserSlot, releaseUserSlot } from "../core/user-manager.js";
import type { UserIdentity } from "../core/user-manager.js";
import { countTokens } from "../core/tokenizer.js";
import { QwenStreamParser } from "../utils/qwen-stream-parser.js";
import { collectNonStreamingResult } from "./stream-handler.js";
import { trackUsage, trackModelUsage } from "../core/usage-tracker.js";

function resolveModelName(model?: string): string {
  if (!model) return "qwen3.7-plus";
  const m = model.toLowerCase();
  if (m === "qwen-plus" || m.startsWith("qwen-plus")) return "qwen3.7-plus";
  if (m === "qwen-max" || m.startsWith("qwen-max")) return "qwen3.8-max";
  if (m.includes("max") || m.includes("opus")) {
    return m.includes("thinking") ? "qwen3.8-max-thinking" : "qwen3.8-max";
  }
  if (m.includes("thinking")) {
    return "qwen3.7-plus-thinking";
  }
  if (m.startsWith("claude") || m === "sonnet" || m === "haiku") {
    return "qwen3.7-plus";
  }
  return model;
}

export async function anthropicMessages(c: Context) {
  const user = (c as any).get?.("user") as UserIdentity | undefined;
  let userSlotHeld = false;
  let userSlotReleased = false;
  const completionId = `comp_${crypto.randomUUID().replace(/-/g, "")}`;

  const releaseUserSlotOnce = () => {
    if (!userSlotHeld || userSlotReleased || !user) return;
    releaseUserSlot(user.id);
    userSlotReleased = true;
  };

  let body: any;
  try {
    body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
    }
  } catch {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  try {
    const isStream = Boolean(body.stream);
    const rawModel = body.model || "qwen3.7-plus";
    const targetModel = resolveModelName(rawModel);
    const isThinkingModel = targetModel.includes("thinking");

    if (user) {
      if (!checkUserRateLimit(user.id, user.rateLimitRpm)) {
        return c.json({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: `Rate limit exceeded for user ${user.id}`,
          },
        }, 429);
      }

      if (!tryAcquireUserSlot(user.id, user.maxConcurrency)) {
        return c.json({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: `Concurrency limit exceeded for user ${user.id} (max ${user.maxConcurrency})`,
          },
        }, 429);
      }
      userSlotHeld = true;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const openAIMessages: OpenAIRequest["messages"] = [];

    if (body.system) {
      if (typeof body.system === "string") {
        openAIMessages.push({ role: "system", content: body.system });
      } else if (Array.isArray(body.system)) {
        const sysText = body.system.map((s: any) => s?.text || "").join("\n");
        openAIMessages.push({ role: "system", content: sysText });
      }
    }

    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      if (typeof msg.content === "string") {
        openAIMessages.push({ role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let textParts = "";
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") {
            textParts += (block.text || "") + "\n";
          } else if (block.type === "tool_result") {
            const contentStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
            textParts += `[Tool Result for ${block.tool_use_id}]: ${contentStr}\n`;
          } else if (block.type === "tool_use") {
            textParts += `[Tool Use: ${block.name} (${block.id})]: ${JSON.stringify(block.input || {})}\n`;
          }
        }
        openAIMessages.push({ role, content: textParts.trim() });
      }
    }

    const rawPromptText = openAIMessages.map(m => `${m.role}: ${m.content}`).join("\n");
    const inputTokens = Math.max(1, countTokens(rawPromptText));

    const finalPrompt = openAIMessages.map(m => {
      const role = m.role === "assistant" ? "Assistant" : (m.role === "system" ? "System" : "User");
      return `${role}: ${m.content}`;
    }).join("\n\n") + "\n\nAssistant:";

    const baseStreamOptions = {
      forceBootstrap: false,
    };

    const stopToken = crypto.randomUUID();
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

    let streamResult: { stream: ReadableStream; uiSessionId: string };
    const accounts = loadAccounts();
    const isGuestModeOnly = accounts.length === 0;

    if (isGuestModeOnly) {
      const result = await createQwenStream(
        finalPrompt,
        isThinkingModel,
        targetModel,
        null,
        "guest",
        undefined,
        undefined,
        { ...baseStreamOptions, forceBootstrap: true }
      );
      registerStream(completionId, {
        abortController: result.controller,
        accountId: "guest",
        uiSessionId: result.uiSessionId,
        targetResponseId: "",
        headers: result.headers,
        stopToken,
      });
      streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
    } else {
      const selectedAccount = getNextAccount();
      if (!selectedAccount) {
        const result = await createQwenStream(
          finalPrompt,
          isThinkingModel,
          targetModel,
          null,
          "guest",
          undefined,
          undefined,
          { ...baseStreamOptions, forceBootstrap: true }
        );
        registerStream(completionId, {
          abortController: result.controller,
          accountId: "guest",
          uiSessionId: result.uiSessionId,
          targetResponseId: "",
          headers: result.headers,
          stopToken,
        });
        streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
      } else {
        const accountId = selectedAccount.id;
        try {
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            targetModel,
            null,
            accountId,
            undefined,
            undefined,
            baseStreamOptions
          );
          registerStream(completionId, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: "",
            headers: result.headers,
            stopToken,
          });
          releaseAccountInUse(accountId);
          streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
        } catch (err: any) {
          releaseAccountInUse(accountId);
          console.warn(`[Anthropic] Account ${accountId} stream failed, falling back to guest: ${err?.message}`);
          if (/rate limit|429/i.test(err?.message || "")) {
            markAccountRateLimited(accountId);
          }
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            targetModel,
            null,
            "guest",
            undefined,
            undefined,
            { ...baseStreamOptions, forceBootstrap: true }
          );
          registerStream(completionId, {
            abortController: result.controller,
            accountId: "guest",
            uiSessionId: result.uiSessionId,
            targetResponseId: "",
            headers: result.headers,
            stopToken,
          });
          streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
        }
      }
    }

    const onComplete = (outputTokens = 1) => {
      removeStream(completionId);
      releaseUserSlotOnce();
      if (user?.id) {
        trackUsage(user.id, rawPromptText, false);
      }
      trackModelUsage(targetModel);
    };

    if (isStream) {
      return handleAnthropicStream(
        c,
        streamResult.stream,
        rawModel,
        completionId,
        streamResult.uiSessionId,
        inputTokens,
        hasTools,
        body.tools || [],
        onComplete
      );
    } else {
      return await handleAnthropicNonStreaming(
        c,
        streamResult.stream,
        rawModel,
        completionId,
        streamResult.uiSessionId,
        inputTokens,
        hasTools,
        body.tools || [],
        onComplete
      );
    }

  } catch (err: any) {
    if (completionId) removeStream(completionId);
    releaseUserSlotOnce();
    console.error("[Anthropic API Error]:", err);
    return c.json({ type: "error", error: { type: "api_error", message: err.message || "Internal Server Error" } }, 500);
  }
}

function handleAnthropicStream(
  c: Context,
  stream: ReadableStream,
  model: string,
  completionId: string,
  uiSessionId: string,
  inputTokens: number,
  hasTools: boolean,
  tools: any[],
  onComplete?: (outTokens: number) => void,
) {
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return honoStream(c, async (streamWriter: any) => {
    streamWriter.onAbort?.(() => {
      abortStream(completionId);
    });

    let heartbeatInterval: any;
    let blockIndex = 0;
    let textBlockOpen = false;
    let totalOutputTokens = 0;
    let stopReason = "end_turn";
    let reader: any;
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const sendEvent = (event: string, data: any) => {
      streamWriter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      });

      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(": keep-alive\n\n");
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      reader = stream.getReader();
      const decoder = new TextDecoder();
      let streamEnded = false;
      let rawBuffer = "";

      const formattedTools: any[] = tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || {},
        },
      }));

      const qwenParser = new QwenStreamParser(uiSessionId, {
        tools: hasTools ? formattedTools : [],
        onAnswer: (deltaText: string) => {
          if (!deltaText) return;
          if (!textBlockOpen) {
            textBlockOpen = true;
            sendEvent("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" },
            });
          }
          sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: deltaText },
          });
          totalOutputTokens += Math.ceil(deltaText.length / 4);
        },
        onToolCall: (tc) => {
          stopReason = "tool_use";
          if (textBlockOpen) {
            sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
            textBlockOpen = false;
            blockIndex++;
          }
          const toolId = tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const argsStr = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {});

          sendEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: toolId,
              name: tc.name,
              input: {},
            },
          });
          sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: argsStr,
            },
          });
          sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
          blockIndex++;
        },
      });

      while (!streamEnded) {
        const { done, value } = await reader.read();
        if (done) break;

        rawBuffer += decoder.decode(value, { stream: true });
        const lines = rawBuffer.split("\n");
        rawBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "data: [DONE]") {
            streamEnded = true;
            break;
          }
          if (trimmed.startsWith("data: ")) {
            qwenParser.parseLine(trimmed.slice(6));
          }
        }
      }

      if (rawBuffer.trim() && rawBuffer.trim().startsWith("data: ") && rawBuffer.trim() !== "data: [DONE]") {
        qwenParser.parseLine(rawBuffer.trim().slice(6));
      }

      if (textBlockOpen) {
        sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
      }

      const finalOutputTokens = qwenParser.usage?.completionTokens && qwenParser.usage.completionTokens > 0
        ? qwenParser.usage.completionTokens
        : Math.max(1, totalOutputTokens);

      sendEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: finalOutputTokens },
      });
      sendEvent("message_stop", { type: "message_stop" });

    } catch (err: any) {
      console.error("[Anthropic Stream Error]:", err);
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (reader) reader.cancel().catch(() => {});
      onComplete?.(totalOutputTokens || 1);
    }
  });
}

async function handleAnthropicNonStreaming(
  c: Context,
  stream: ReadableStream,
  model: string,
  completionId: string,
  uiSessionId: string,
  inputTokens: number,
  hasTools: boolean,
  tools: any[],
  onComplete?: (outTokens: number) => void,
) {
  const formattedTools: any[] = tools.map((t: any) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  const result = await collectNonStreamingResult(
    c,
    stream,
    completionId,
    model,
    uiSessionId,
    hasTools,
    formattedTools,
    () => {},
  );

  const contentBlocks: any[] = [];
  if (result.content) {
    contentBlocks.push({ type: "text", text: result.content });
  }
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      let inputObj = {};
      try {
        inputObj = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
      } catch {
        inputObj = { raw: tc.function?.arguments };
      }
      contentBlocks.push({
        type: "tool_use",
        id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        name: tc.function?.name,
        input: inputObj,
      });
    }
  }

  const outTokens = result.body?.usage?.completion_tokens || Math.ceil((result.content || "").length / 4);
  onComplete?.(Math.max(1, outTokens));

  return c.json({
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: result.toolCalls && result.toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: Math.max(1, outTokens),
    },
  });
}
