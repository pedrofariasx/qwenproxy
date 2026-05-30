/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableQwenStreamError, QwenUpstreamError } from '../services/qwen.ts';
import { config } from '../core/config.js';
import { runExecutionLoop } from '../tools/executor.ts';
import type { LLMSendFunction } from '../tools/executor.ts';
import { Mutex } from '../services/playwright.ts';
import { sanitizeError } from '../utils/error-sanitization.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { validateChatRequest } from '../types/validation.ts';
import { Logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';

const logger = new Logger('info', 'Chat')

const accountMutexes = new Map<string, Mutex>();
const accountMutexLastUsed = new Map<string, number>();

function removeAccountMutex(accountId: string): void {
  accountMutexes.delete(accountId);
  accountMutexLastUsed.delete(accountId);
}

function sweepOrphanedAccountMutexes(): void {
  if (accountMutexes.size <= 100) return;
  const now = Date.now();
  const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;
  for (const [accountId, lastUsed] of accountMutexLastUsed) {
    if (now - lastUsed > ORPHAN_THRESHOLD_MS) {
      removeAccountMutex(accountId);
    }
  }
}

function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
    sweepOrphanedAccountMutexes();
  }
  accountMutexLastUsed.set(accountId, Date.now());
  return mutex;
}

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr };
  }

  // Heuristic to detect if newStr is cumulative or incremental:
  // If newStr is cumulative, it should share a common prefix with oldStr.
  // Limit scan window to avoid O(n) on very long cumulative content
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  // We avoid fallback search/sliding overlap checks which cause disastrous false-positive
  // corruptions on incremental streams with repetitive code/words (like "import {", "const", etc.).
  return {
    delta: newStr,
    matchedContent: oldStr + newStr
  };
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const validation = validateChatRequest(body);
    if (!validation.success) {
      const issues = validation.error.issues.map(i => i.message).join('; ');
      return c.json({ error: { message: issues, type: 'invalid_request_error' } }, 400);
    }
    const isStream = body.stream ?? false;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += (contentStr || '') + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr || ''}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = msg.reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: Record<string, unknown> = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
      }
    }

    // Inject tools instructions
    const hasTools = body.tools && Array.isArray(body.tools) && body.tools.length > 0;
    const toolChoice = body.tool_choice;

    // Edge case: tool_choice='required' without tools -> return 400 error
    if (toolChoice === 'required' && !hasTools) {
      return c.json({ error: { message: "tool_choice 'required' requires at least one tool to be provided", type: 'invalid_request_error' } }, 400);
    }

    // If no tools or empty array: don't add anything regardless of tool_choice
    if (hasTools && toolChoice !== 'none') {
      // Better formatting for tools
      const formattedTools = (body.tools || []).map(t => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`;
      
      if (typeof toolChoice === 'object' && toolChoice?.type === 'function' && toolChoice?.function?.name) {
        // Prompt injection protection: validate tool name against registered tools
        const rawName = toolChoice.function.name;
        const matchingTool = (body.tools || []).find(t =>
          t.type === 'function' && t.function.name === rawName
        );
        if (!matchingTool) {
          return c.json({ error: { message: "Tool name does not match any registered tool", type: 'invalid_request_error' } }, 400);
        }
        // Use validated name from tool definition (not raw input)
        systemPrompt += `CRITICAL: You MUST call the tool "${matchingTool.function.name}" in this response.\n\n`;
      } else if (toolChoice === 'required') {
        systemPrompt += `CRITICAL: Você DEVE usar uma tool nesta resposta.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '');

    // EXECUTOR_ENABLED + streaming is not supported (lock not acquired yet, safe to return early)
    if (config.executor.enabled && body.stream) {
      return c.json({ error: { message: 'EXECUTOR_ENABLED is not compatible with streaming. Use stream=false or EXECUTOR_ENABLED=false.', type: 'invalid_request_error' } }, 400);
    }

    const modelContextWindow = getModelContextWindow(modelId)
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);
    
    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt);
      finalPrompt = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: unknown = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    let releaseChatLock: (() => void) | undefined;
      let effectiveAccountId: string | undefined;
    let completionId = '';

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        logger.info(`Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
        account = getNextAvailableAccount(accountId);
        continue;
      }

      logger.info(`Routing request to account: ${accountEmail} (${accountId})`);

    const accountMutex = getAccountMutex(accountId);
    releaseChatLock = await accountMutex.acquire();
    completionId = 'chatcmpl-' + uuidv4();

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
              accountId === 'global' ? undefined : accountId
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
            effectiveAccountId = accountId;
            success = true;
            break;
          } catch (err: unknown) {
            retries--;
            const qwenErr = err as { upstreamCode?: string; upstreamStatus?: number; message?: string };

            if (qwenErr.upstreamCode === 'RateLimited' || qwenErr.upstreamStatus === 429) {
              const hourHint = qwenErr.message?.match(/Wait about (\d+) hour/);
              const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
              markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
              logger.warn(`Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`);
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            if (retries === 0) {
              if (qwenErr.upstreamStatus && qwenErr.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, 'ServerError');
                logger.warn(`Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
              }
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            let useDelay = retryDelay;
            if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableQwenStreamError || qwenErr.message?.includes('in progress') || qwenErr.message?.includes('Bad_Request');
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            logger.warn(`Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        releaseChatLock = undefined;
        account = getNextAvailableAccount(accountId);
        continue;
      } catch (err: unknown) {
        releaseChatLock?.();
        releaseChatLock = undefined;
        lastError = err;
        account = getNextAvailableAccount(accountId);
      }
    }

    if (!stream) {
      throw lastError || new Error('All accounts failed');
    }

    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser(body.tools || []);
      const toolCallsOut: any[] = [];
      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              updateSessionParent(uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              updateSessionParent(uiSessionId, chunk.response_id);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                reasoningBuffer += vStr;
              } else {
                const { text, toolCalls } = toolParser.feed(vStr);
                // text is the lead-in before any tool_call tag.
                // We skip emitting it here because OpenAI-compatible clients
                // expect a structured tool_calls message when the assistant
                // invokes tools. The lead-in is preserved in the parser and
                // will be recovered only if the tool call fails to parse.
                for (const tc of toolCalls) {
                  toolCallsOut.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
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
        releaseChatLock?.();
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      for (const tc of remainingToolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      }

      // ── Task 6: Model tool-usage detection (non-streaming) ──
      if (hasTools) {
        const isRequired = toolChoice === 'required' ||
          (typeof toolChoice === 'object' && toolChoice?.type === 'function');

        if (toolCallsOut.length === 0) {
          if (isRequired) {
            logger.error('Model failed to invoke tools (tool_choice=required, no tool_calls in response)');
            releaseChatLock?.();
            return c.json({ error: { message: 'Model failed to invoke tools', type: 'server_error' } }, 502);
          }
          logger.info('Model chose not to invoke tools (tool_choice=auto, no tool_calls in response)');
        }

        // Check for refusal keywords when no tools were called
        if (toolCallsOut.length === 0 && lastFullContent) {
          const refusalKeywords = ['cannot assist', 'i cannot', "i'm sorry", 'i cannot fulfill', 'cannot complete', 'unable to', 'i am not able'];
          const lowerContent = lastFullContent.toLowerCase();
          if (refusalKeywords.some(k => lowerContent.includes(k))) {
            logger.warn('Model response contains refusal keywords — tool call may have been refused');
          }
        }
      }

      // ── Task 11: Tool parse metrics (non-streaming) ──
      if (toolCallsOut.length > 0) {
        metrics.increment('tools_parsed_total', toolCallsOut.length, { method: 'non-streaming' });
      }

      // ── Task 4: ExecutionLoop (non-streaming only) ──
      if (config.executor.enabled && toolCallsOut.length > 0) {
        logger.info('[Executor] Server-side tool execution activated');
        const body = await c.req.json();
        if (body.stream) {
          releaseChatLock?.();
          return c.json({ error: { message: 'EXECUTOR_ENABLED is not compatible with streaming. Use stream=false.', type: 'invalid_request_error' } }, 400);
        }
        const executorSendToLLM: LLMSendFunction = async (msgs, _tools, _model) => {
          const promptText = (msgs as any[]).map((m: any) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
          const { stream, controller } = await createQwenStream(promptText, false, modelId, null, effectiveAccountId);
          const parser = new StreamingToolParser();
          const reader = stream.getReader();
          let fullContent = '';
          let toolCalls: any[] = [];
          let finishReason = 'stop';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = new TextDecoder().decode(value);
              fullContent += text;
              const result = parser.feed(text);
              if (result.toolCalls.length > 0) {
                toolCalls = result.toolCalls;
                finishReason = 'tool_calls';
              }
            }
          } finally {
            reader.releaseLock();
            controller.abort();
          }
          return { content: fullContent || null, toolCalls: toolCalls || [], finishReason };
        };
        const result = await runExecutionLoop(executorSendToLLM, messages, modelId, {
          maxTurns: config.executor.maxTurns,
          timeoutMs: config.executor.timeoutMs,
        });
        const usage2 = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: 0 }
        };
        releaseChatLock?.();
        return c.json({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }],
          usage: usage2,
        });
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) {
        let toolCallIndex = 0;
        for (const tc of toolCallsOut) {
          tc.index = toolCallIndex++;
        }
      }
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      releaseChatLock?.();
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      try {
      // Send heartbeat to prevent Cloudflare 524 timeout
      await streamWriter.write(': heartbeat\n\n');

      // Set up a periodic heartbeat to keep the connection alive during long thinking phases
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n').catch(() => {});
        } catch (e) {
          clearInterval(heartbeatInterval);
        }
      }, 15000); // Every 15 seconds

      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      let inThinkingState = false;
      let thinkingFragments: Record<string, boolean> = {};
      let currentThoughtIndex = 0;
      let currentAppendPath = '';
      
       let reasoningBuffer = '';
       let lastFullContent = '';
       let targetResponseId: string | null = null;
       const toolParser = new StreamingToolParser(body.tools || []);
       let toolCallIndex = 0;

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            await streamWriter.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);

            // Extract response_id for session tracking and target filtering
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              updateSessionParent(uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              updateSessionParent(uiSessionId, chunk.response_id);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              if (isThinkingChunk) {
                inThinkingState = true;
                reasoningBuffer += vStr;
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })]
                });
              } else {
                inThinkingState = false;
                const { text, toolCalls } = toolParser.feed(vStr);

                if (text) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ content: text })]
                  });
                }

                for (const tc of toolCalls) {
                  const index = toolCallIndex++;
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index,
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments: JSON.stringify(tc.arguments)
                        }
                      }]
                    })]
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
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, 'stop')]
        });
        await streamWriter.write('data: [DONE]\n\n');
        return;
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: remainingText })]
        });
      }
      for (const tc of remainingToolCalls) {
        const index = toolCallIndex++;
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }]
          })]
        });
      }

      // ── Task 6: Model tool-usage detection (streaming) ──
      if (hasTools) {
        const isRequired = toolChoice === 'required' ||
          (typeof toolChoice === 'object' && toolChoice?.type === 'function');
        const totalToolCalls = toolParser.getEmittedToolCallCount();

        if (totalToolCalls === 0) {
          if (isRequired) {
            logger.error('Model failed to invoke tools (tool_choice=required, no tool_calls in streaming response)');
          } else {
            logger.info('Model chose not to invoke tools (tool_choice=auto, no tool_calls in streaming response)');
          }
        }

        // Check for refusal keywords when no tools were called
        if (totalToolCalls === 0 && lastFullContent) {
          const refusalKeywords = ['cannot assist', 'i cannot', "i'm sorry", 'i cannot fulfill', 'cannot complete', 'unable to', 'i am not able'];
          const lowerContent = lastFullContent.toLowerCase();
          if (refusalKeywords.some(k => lowerContent.includes(k))) {
            logger.warn('Model streaming response contains refusal keywords — tool call may have been refused');
          }
        }
      }

      // ── Task 11: Tool parse metrics (streaming) ──
      if (toolParser.getEmittedToolCallCount() > 0) {
        metrics.increment('tools_parsed_total', toolParser.getEmittedToolCallCount(), { method: 'streaming' });
      }

      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage })
      });

      if (body.stream_options?.include_usage) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [],
          usage
        });
      }
      await streamWriter.write('data: [DONE]\n\n');

      } finally {
        clearInterval(heartbeatInterval);
        await removeStream(completionId);
        releaseChatLock?.();
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error in chatCompletions: ' + msg);
    const isProd = process.env.NODE_ENV === 'production';
    const sanitized = sanitizeError(err, isProd);
    const statusCode = err instanceof QwenUpstreamError ? err.upstreamStatus : 500;
    return c.json({ error: sanitized }, statusCode as any);
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: 'chat_id and response_id are required' }, 400);
    }

    const stream = await getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${chat_id}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': uuidv4(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id, response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      logger.error(`Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    await removeStream(chat_id);

    logger.info(`Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Error in chatCompletionsStop: ' + msg);
    return c.json({ error: msg }, 500);
  }
}
