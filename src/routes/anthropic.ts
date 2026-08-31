import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import crypto from 'crypto';
import type { OpenAIRequest } from '../utils/types.js';
import { createQwenStream, RetryableQwenStreamError } from '../services/qwen.js';
import { getNextAccount, getNextAvailableAccount, getAccountById, markAccountRateLimited, onAccountFreed, getAccountCooldownInfo, markAccountInUse, releaseAccountInUse } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js';
import { config } from '../core/config.js';
import { checkUserRateLimit, tryAcquireUserSlot, releaseUserSlot, getUserActiveStreams } from '../core/user-manager.js';
import type { UserIdentity } from '../core/user-manager.js';
import { countTokens } from '../core/tokenizer.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { collectNonStreamingResult } from './stream-handler.js';
import { trackUsage, trackModelUsage } from '../core/usage-tracker.js';

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
  const user = (c as any).get?.('user') as UserIdentity | undefined;
  let userSlotHeld = false;
  let userSlotReleased = false;
  const releaseUserSlotOnce = () => {
    if (!userSlotHeld || userSlotReleased || !user) return;
    userSlotReleased = true;
    releaseUserSlot(user.id);
  };

  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const isStream = body.stream ?? false;
    metrics.increment('requests.completions');

    if (user) {
      if (!checkUserRateLimit(user.id, user.rateLimitRpm)) {
        return c.json({ type: 'error', error: { type: 'rate_limit_error', message: `Rate limit exceeded for user ${user.id}` } }, 429);
      }
      if (!tryAcquireUserSlot(user.id, user.maxConcurrency)) {
        return c.json({ type: 'error', error: { type: 'rate_limit_error', message: `Concurrency limit exceeded for user ${user.id} (max ${user.maxConcurrency})` } }, 429);
      }
      userSlotHeld = true;
    }

    const rawModel = body.model || 'qwen-plus';
    const targetModel = resolveModelName(rawModel);
    const isThinkingModel = targetModel.endsWith('-thinking');

    // 1. Build system prompt
    let systemPrompt = '';
    if (typeof body.system === 'string') {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = body.system.map((s: any) => (typeof s === 'string' ? s : s.text || '')).join('\n');
    }

    // 2. Build messages and prompt string
    const promptParts: string[] = [];
    if (systemPrompt.trim()) {
      promptParts.push(`System: ${systemPrompt.trim()}\n`);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        if (msg.role === 'assistant') {
          promptParts.push(`Assistant: ${msg.content}\n`);
        } else {
          promptParts.push(`User: ${msg.content}\n`);
        }
      } else if (Array.isArray(msg.content)) {
        let textPart = '';
        const toolCalls: any[] = [];
        const toolResults: any[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textPart += (textPart ? '\n' : '') + (block.text || '');
          } else if (block.type === 'tool_use') {
            const args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {});
            toolCalls.push({ name: block.name, arguments: args });
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            toolResults.push({ id: block.tool_use_id, content });
          }
        }

        if (msg.role === 'assistant') {
          let assistantContent = textPart;
          for (const tc of toolCalls) {
            let parsedArgs = tc.arguments;
            try { parsedArgs = JSON.parse(tc.arguments); } catch {}
            const callStr = `\n<tool_call>\n${JSON.stringify({ name: tc.name, arguments: parsedArgs })}\n</tool_call>`;
            assistantContent = assistantContent ? assistantContent + callStr : callStr.trim();
          }
          if (assistantContent) {
            promptParts.push(`Assistant: ${assistantContent}\n`);
          }
        } else {
          if (textPart) {
            promptParts.push(`User: ${textPart}\n`);
          }
          for (const tr of toolResults) {
            promptParts.push(`Tool Response: ${tr.content}\n`);
          }
        }
      }
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (hasTools) {
      const formattedTools = body.tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {}
      }));
      const toolsJson = JSON.stringify(formattedTools);
      const toolDirective = `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in <tool_call> tags:\n\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling.\n2. Output tool call immediately without preamble when needed.\n\n`;
      promptParts.unshift(toolDirective);
    }

    const finalPrompt = promptParts.join('\n');
    const inputTokens = countTokens(finalPrompt);
    const completionId = `comp_${crypto.randomUUID().replace(/-/g, '')}`;
    const stopToken = crypto.randomUUID();

    // Stream retrieval logic matching qwenproxy core
    const isGuestModeOnly = config.qwen.guestModeOnly;
    const baseStreamOptions = {
      streamOptions: undefined,
      completionId,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      authUserId: user?.id,
    };

    let retries = 3;
    let streamResult: { stream: ReadableStream; uiSessionId: string } | null = null;

    if (isGuestModeOnly) {
      const result = await createQwenStream(
        finalPrompt,
        isThinkingModel,
        targetModel,
        null,
        'guest',
        undefined,
        undefined,
        { ...baseStreamOptions, forceBootstrap: true }
      );
      registerStream(completionId, {
        abortController: result.controller,
        accountId: 'guest',
        uiSessionId: result.uiSessionId,
        targetResponseId: '',
        headers: result.headers,
        stopToken,
      });
      streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
    } else {
      const accounts = loadAccounts();
      const account = getNextAccount();
      const accountId = account?.id;

      if (!accountId) {
        // Fallback to guest
        const result = await createQwenStream(
          finalPrompt,
          isThinkingModel,
          targetModel,
          null,
          'guest',
          undefined,
          undefined,
          { ...baseStreamOptions, forceBootstrap: true }
        );
        registerStream(completionId, {
          abortController: result.controller,
          accountId: 'guest',
          uiSessionId: result.uiSessionId,
          targetResponseId: '',
          headers: result.headers,
          stopToken,
        });
        streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
      } else {
        markAccountInUse(accountId);
        try {
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            targetModel,
            null,
            accountId === 'global' ? undefined : accountId,
            undefined,
            undefined,
            { ...baseStreamOptions, forceBootstrap: false }
          );
          registerStream(completionId, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
            stopToken,
          });
          releaseAccountInUse(accountId);
          streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
        } catch (err: any) {
          releaseAccountInUse(accountId);
          // Guest fallback on failure
          const result = await createQwenStream(
            finalPrompt,
            isThinkingModel,
            targetModel,
            null,
            'guest',
            undefined,
            undefined,
            { ...baseStreamOptions, forceBootstrap: true }
          );
          registerStream(completionId, {
            abortController: result.controller,
            accountId: 'guest',
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
            stopToken,
          });
          streamResult = { stream: result.stream, uiSessionId: result.uiSessionId };
        }
      }
    }

    const onComplete = () => {
      removeStream(completionId);
      releaseUserSlotOnce();
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
      return handleAnthropicNonStreaming(
        c,
        streamResult.stream,
        rawModel,
        streamResult.uiSessionId,
        inputTokens,
        hasTools,
        body.tools || [],
        onComplete
      );
    }

  } catch (err: any) {
    releaseUserSlotOnce();
    console.error('[Anthropic API Error]:', err);
    return c.json({ type: 'error', error: { type: 'api_error', message: err.message || 'Internal Server Error' } }, 500);
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
  onComplete?: () => void,
) {
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    let blockIndex = 0;
    let textBlockOpen = false;
    let totalOutputTokens = 0;
    let stopReason = 'end_turn';
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

    const sendEvent = (event: string, data: any) => {
      streamWriter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendEvent('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 },
        },
      });

      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let streamEnded = false;
      let rawBuffer = '';

      const formattedTools = tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {}
      }));

      const qwenParser = new QwenStreamParser(uiSessionId, {
        tools: hasTools ? formattedTools : [],
        onAnswer: (deltaText: string) => {
          if (!deltaText) return;
          if (!textBlockOpen) {
            textBlockOpen = true;
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: deltaText },
          });
          totalOutputTokens += Math.ceil(deltaText.length / 4);
        },
        onToolCall: (tc) => {
          stopReason = 'tool_use';
          if (textBlockOpen) {
            sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            textBlockOpen = false;
            blockIndex++;
          }
          const toolId = tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
          const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {});

          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: tc.name,
              input: {},
            },
          });
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argsStr,
            },
          });
          sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
        },
      });

      while (!streamEnded) {
        const { done, value } = await reader.read();
        if (done) break;

        rawBuffer += decoder.decode(value, { stream: true });
        const lines = rawBuffer.split('\n');
        rawBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === 'data: [DONE]') {
            streamEnded = true;
            break;
          }
          if (trimmed.startsWith('data: ')) {
            qwenParser.parseLine(trimmed.slice(6));
          }
        }
      }

      if (rawBuffer.trim() && rawBuffer.trim().startsWith('data: ') && rawBuffer.trim() !== 'data: [DONE]') {
        qwenParser.parseLine(rawBuffer.trim().slice(6));
      }

      if (textBlockOpen) {
        sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      }

      sendEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: Math.max(1, totalOutputTokens) },
      });
      sendEvent('message_stop', { type: 'message_stop' });

    } catch (err: any) {
      console.error('[Anthropic Stream Error]:', err);
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      onComplete?.();
    }
  });
}

async function handleAnthropicNonStreaming(
  c: Context,
  stream: ReadableStream,
  model: string,
  uiSessionId: string,
  inputTokens: number,
  hasTools: boolean,
  tools: any[],
  onComplete?: () => void,
) {
  const formattedTools = tools.map((t: any) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || {}
  }));

  const result = await collectNonStreamingResult(
    c,
    stream,
    `comp_${crypto.randomUUID().replace(/-/g, '')}`,
    model,
    uiSessionId,
    hasTools,
    formattedTools,
    onComplete,
  );

  const contentBlocks: any[] = [];
  if (result.content) {
    contentBlocks.push({ type: 'text', text: result.content });
  }
  if (result.tool_calls && Array.isArray(result.tool_calls)) {
    for (const tc of result.tool_calls) {
      let inputObj = {};
      try {
        inputObj = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
      } catch {
        inputObj = { raw: tc.function?.arguments };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        name: tc.function?.name,
        input: inputObj,
      });
    }
  }

  const outTokens = result.usage?.completion_tokens || Math.ceil((result.content || '').length / 4);

  return c.json({
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: result.tool_calls && result.tool_calls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: Math.max(1, outTokens),
    },
  });
}
