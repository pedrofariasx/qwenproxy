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
import { createQwenStream, stopQwenGeneration, updateSessionParent } from '../services/qwen.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { Mutex } from '../services/playwright.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { createDebugTrace, detectClientName } from '../core/debug-console.ts';
import { terminal } from '../core/terminal.ts';
import {
  getForcedToolName,
  normalizeChatRequest,
  openAIErrorBody,
  openAIErrorFrom,
  parseJsonBody,
} from '../core/openai-compat.ts';

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

async function stopUpstreamAfterToolCall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  uiSessionId: string,
  responseId: string | null,
  headers: Record<string, string> | null
): Promise<void> {
  if (uiSessionId && responseId && headers) {
    await stopQwenGeneration(uiSessionId, responseId, headers).catch(() => {});
  }
  await reader.cancel().catch(() => {});
}

export async function chatCompletions(c: Context) {
  let debugTrace: ReturnType<typeof createDebugTrace> | null = null;
  try {
    const body = normalizeChatRequest(await parseJsonBody(c.req.raw));
    const isStream = body.stream ?? false;
    const bodyAny = body as any;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    debugTrace = createDebugTrace({
      id: `chat-${uuidv4().slice(0, 8)}`,
      route: 'chat.completions',
      client: detectClientName(c.req.header('user-agent'), c.req.header('x-qwenproxy-client')),
      model: body.model,
      stream: isStream,
      messages,
      tools: bodyAny.tools,
    });
    c.header('X-QwenProxy-Debug-Id', debugTrace.id);
    
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
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
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
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
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
      
      const forcedTool = getForcedToolName(bodyAny.tool_choice);
      if (forcedTool) {
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId)
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);
    
    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt);
      finalPrompt = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }
    debugTrace.prompt(finalPrompt, { estimatedTokens, contextWindow: modelContextWindow });

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    let upstreamHeaders: Record<string, string> | null = null;
    const completionId = 'chatcmpl-' + uuidv4();
    let releaseChatLock: (() => void) | undefined;

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
        terminal.warn('Chat', `Skipping ${accountEmail}; account on cooldown`, [
          `remaining: ${Math.round(cooldownInfo.remainingMs / 1000)}s`,
          `reason: ${cooldownInfo.reason}`,
        ]);
        account = getNextAvailableAccount(accountId);
        continue;
      }

      terminal.info('Chat', `Routing request to ${accountEmail}`, [`id: ${accountId}`]);
      debugTrace.account(accountEmail, accountId);

    const accountMutex = getAccountMutex(accountId);
    releaseChatLock = await accountMutex.acquire();

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
              null,
              accountId === 'global' ? undefined : accountId
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            upstreamHeaders = result.headers;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
            success = true;
            break;
          } catch (err: any) {
            retries--;

            if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
              const hourHint = err.message?.match(/Wait about (\d+) hour/);
              const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
              markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
              terminal.warn('Chat', `${accountEmail} hit Qwen rate limit`, [`id: ${accountId}`]);
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            if (retries === 0) {
              if (err.upstreamStatus && err.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, 'ServerError');
                terminal.warn('Chat', `${accountEmail} returned upstream server error`, [`id: ${accountId}`]);
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
            const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            terminal.warn('Chat', `Retrying Qwen request for ${accountEmail}`, [
              `delay: ${useDelay}ms`,
              `left: ${retries}`,
            ]);
            debugTrace.retry(err.message || 'Qwen request failed');
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
      } catch (err: any) {
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
      let stopAfterToolCall = false;
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
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
              const registered = getStream(completionId);
              if (registered) registered.targetResponseId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              updateSessionParent(uiSessionId, chunk.response_id);
              const registered = getStream(completionId);
              if (registered) registered.targetResponseId = chunk.response_id;
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
                  const toolCall = {
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  };
                  toolCallsOut.push(toolCall);
                  debugTrace.toolCall(toolCall);
                }
                if (toolCalls.length > 0) {
                  stopAfterToolCall = true;
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
          if (stopAfterToolCall) break;
        }
        if (stopAfterToolCall) break;
      }

      if (stopAfterToolCall) {
        await stopUpstreamAfterToolCall(reader, uiSessionId, targetResponseId, upstreamHeaders);
      }

      const upstreamError = stopAfterToolCall ? null : parseQwenErrorPayload(buffer);
      if (upstreamError) {
        releaseChatLock?.();
        debugTrace.failed(upstreamError.message);
        return c.json(openAIErrorBody(upstreamError.message, upstreamError.status, {
          code: upstreamError.status === 429 ? 'rate_limited' : 'upstream_error',
        }), upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      for (const tc of remainingToolCalls) {
        const toolCall = {
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        };
        toolCallsOut.push(toolCall);
        debugTrace.toolCall(toolCall);
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      releaseChatLock?.();
      const finishReason = toolCallsOut.length ? 'tool_calls' : 'stop';
      debugTrace.completed({
        outputText: lastFullContent,
        reasoningText: reasoningBuffer,
        toolCalls: toolCallsOut,
        usage,
        finishReason,
      });
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: finishReason
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
          await streamWriter.write(': keep-alive\n\n');
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
       const toolParser = new StreamingToolParser(bodyAny.tools || []);
       let streamedAnswer = '';
       const streamedToolCalls: any[] = [];
       let stopAfterToolCall = false;

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
              const registered = getStream(completionId);
              if (registered) registered.targetResponseId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              updateSessionParent(uiSessionId, chunk.response_id);
              const registered = getStream(completionId);
              if (registered) registered.targetResponseId = chunk.response_id;
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
                debugTrace?.streamDelta('reasoning', vStr);
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
                  streamedAnswer += text;
                  debugTrace?.streamDelta('answer', text);
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ content: text })]
                  });
                }

                for (const tc of toolCalls) {
                  const toolCall = {
                    index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  };
                  streamedToolCalls.push(toolCall);
                  debugTrace?.toolCall(toolCall);
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [toolCall]
                    })]
                  });
                }
                if (toolCalls.length > 0) {
                  stopAfterToolCall = true;
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
          if (stopAfterToolCall) break;
        }
        if (stopAfterToolCall) break;
      }

      if (stopAfterToolCall) {
        await stopUpstreamAfterToolCall(reader, uiSessionId, targetResponseId, upstreamHeaders);
      }

      const upstreamError = stopAfterToolCall ? null : parseQwenErrorPayload(buffer);
      if (upstreamError) {
        debugTrace?.failed(upstreamError.message);
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
        streamedAnswer += remainingText;
        debugTrace?.streamDelta('answer', remainingText);
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: remainingText })]
        });
      }
      for (const tc of remainingToolCalls) {
        const toolCall = {
          index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        };
        streamedToolCalls.push(toolCall);
        debugTrace?.toolCall(toolCall);
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [toolCall]
          })]
        });
      }
  
      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
      debugTrace?.completed({
        outputText: streamedAnswer,
        reasoningText: reasoningBuffer,
        toolCalls: streamedToolCalls,
        usage,
        finishReason: finalFinishReason,
      });
  
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
        releaseChatLock?.();
      }
    });
  } catch (err: any) {
    debugTrace?.failed(err);
    const { status, body } = openAIErrorFrom(err);
    console.error(`[Chat] ${status} ${body.error.code || body.error.type}: ${body.error.message}`);
    return c.json(body, status as any);
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json(openAIErrorBody('chat_id and response_id are required', 400, {
        code: 'missing_required_parameter',
      }), 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json(openAIErrorBody('Stream not found', 404, { code: 'stream_not_found' }), 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json(openAIErrorBody('response_id mismatch', 400, { code: 'response_id_mismatch' }), 400);
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
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json(openAIErrorBody('Failed to stop generation', stopResponse.status, {
        code: 'upstream_stop_failed',
      }), stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    const { status, body } = openAIErrorFrom(err);
    return c.json(body, status as any);
  }
}
