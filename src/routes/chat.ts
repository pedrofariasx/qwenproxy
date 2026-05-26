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
import { randomUUID } from 'crypto';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import type { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { clearCachedHeaders } from '../services/playwright.ts';
import { Mutex } from '../services/playwright.ts';
import { TOOL_CALL_INSTRUCTION } from '../constants.ts';
import fs from 'fs';

const DEBUG_LOGS = process.env.DEBUG_LOGS === 'true';

let debugRawLog = '';
let debugProxyLog = '';
let debugPromptLog = '';

function appendRawLog(chunk: string) {
  if (DEBUG_LOGS) debugRawLog += chunk;
}

function appendProxyLog(data: string) {
  if (DEBUG_LOGS) debugProxyLog += data + '\n';
}

function appendPromptLog(prompt: string) {
  if (DEBUG_LOGS) debugPromptLog += '=== PROMPT ENVIADO AO QWEN ===\n' + prompt + '\n=== FIM DO PROMPT ===\n\n';
}

function flushDebugLogs() {
  if (!DEBUG_LOGS) return;
  const ts = Date.now().toString(36);
  try {
    fs.writeFileSync(`debug_raw_${ts}.txt`, debugRawLog);
    fs.writeFileSync(`debug_proxy_${ts}.txt`, debugProxyLog);
    fs.writeFileSync(`debug_prompt_${ts}.txt`, debugPromptLog);
    console.log(`[DEBUG] Logs salvos: debug_raw_${ts}.txt, debug_proxy_${ts}.txt, debug_prompt_${ts}.txt`);
  } catch (e) {
    console.error('[DEBUG] Falha ao salvar logs:', e);
  }
  debugRawLog = '';
  debugProxyLog = '';
  debugPromptLog = '';
}

// Global mutex that serializes ALL Qwen chat completions requests.
// The Qwen web backend is stateful: it only allows one generation at a time
// per session. Concurrent requests to the same session produce:
//   "Bad_Request: The chat is in progress!"
// A single global lock is the safest approach because the proxy currently
// shares one browser session (and therefore one Qwen auth context).
const qwenChatMutex = new Mutex();

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
    // Check if we're cutting in the middle of a <tool_call> or </tool_call> tag
    const partialTag = newStr.substring(0, commonPrefixLen);
    const isPartialOpeningTag = partialTag === '<tool_call' && !newStr.includes('<tool_call>');
    const isPartialClosingTag = partialTag === '</tool_call' && !newStr.includes('</tool_call>');

    if (isPartialOpeningTag || isPartialClosingTag) {
      return {
        delta: '',
        matchedContent: oldStr
      };
    }

    // CRITICAL FIX: If newStr is entirely a prefix of oldStr (newStr <= oldStr and fully matches),
    // but newStr is NOT identical to oldStr (handled above), this is likely an incremental chunk
    // that happens to match the start of oldStr. Treat as incremental, not cumulative.
    if (commonPrefixLen === newStr.length && newStr.length < oldStr.length) {
      return {
        delta: newStr,
        matchedContent: oldStr + newStr
      };
    }

    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr
    };
  }

  // Special case: if oldStr ends with </tool_call> and newStr starts with <tool_call>,
  // we must concatenate to avoid breaking the tag structure
  const trimmedOld = oldStr.trimEnd();
  const trimmedNew = newStr.trimStart();
  const endsWithClosingTag = trimmedOld.endsWith('</tool_call>');
  const startsWithOpeningTag = trimmedNew.startsWith('<tool_call>');

  if (endsWithClosingTag && startsWithOpeningTag) {
    return {
      delta: newStr,
      matchedContent: oldStr + newStr
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  // We avoid fallback search/sliding overlap checks which cause disastrous false-positive
  // corruptions on incremental streams with repetitive code/words (like "import {", "const", etc.).

  // NEW: Detect if this looks like a new tool_call block that should NOT be concatenated
  // If oldStr ends with an incomplete JSON object and newStr starts with content that
  // clearly indicates a new block (like 'name":' without the opening '{'), reset instead of concatenate
  const oldEndsWithOpenBrace = oldStr.endsWith('{') || oldStr.endsWith('<tool_call>\n');
  const newStartsWithContinuation = newStr.startsWith('"') || newStr.startsWith(',') || newStr.startsWith(' ');

  if (oldEndsWithOpenBrace && !newStartsWithContinuation && newStr.includes('name":')) {
    // This looks like a new tool call block starting with "name": without the opening '{'
    // Return newStr as-is, don't concatenate with oldStr
    return {
      delta: newStr,
      matchedContent: newStr
    };
  }

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


interface StreamState {
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  targetResponseId: string | null;
  toolParser: StreamingToolParser;
  completionTokens: number;
  promptTokens: number;
}

interface ChunkOutput {
  reasoningText?: string;
  text?: string;
  toolCalls: import('../utils/types.ts').ParsedToolCall[];
}

function processQwenChunk(
  chunk: any,
  state: StreamState,
  uiSessionId: string
): ChunkOutput | null {
  appendRawLog(JSON.stringify(chunk) + '\n');

  if (chunk['response.created'] && chunk['response.created'].response_id) {
    if (!state.targetResponseId) {
      state.targetResponseId = chunk['response.created'].response_id;
    }
    updateSessionParent(uiSessionId, chunk['response.created'].response_id);
  } else if (chunk.response_id && !state.targetResponseId) {
    state.targetResponseId = chunk.response_id;
    updateSessionParent(uiSessionId, chunk.response_id);
  }

  if (chunk.usage) {
    if (chunk.usage.output_tokens) state.completionTokens = chunk.usage.output_tokens;
    if (chunk.usage.input_tokens) state.promptTokens = chunk.usage.input_tokens;
  }

  let vStr = '';
  let foundStr = false;
  let isThinkingChunk = false;

  if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
      (state.targetResponseId === null || chunk.response_id === state.targetResponseId)) {
    const delta = chunk.choices[0].delta;

    if (delta.phase === 'thinking_summary') {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        if (thoughts.length > state.currentThoughtIndex) {
          vStr = thoughts.slice(state.currentThoughtIndex).join('\n');
          state.currentThoughtIndex = thoughts.length;
          foundStr = true;
        }
      }
    } else if (delta.phase === 'answer') {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        const newContent = delta.content || '';
        const result = getIncrementalDelta(state.lastFullContent, newContent);
        vStr = result.delta;
        if (vStr) {
          state.lastFullContent = result.matchedContent;
          foundStr = true;
        }
      }
    }
  }

  if (!foundStr || vStr === '' || vStr === 'FINISHED') return null;

  if (isThinkingChunk) {
    state.reasoningBuffer += vStr;
    return { reasoningText: vStr, toolCalls: [] };
  }

  const { text, toolCalls } = state.toolParser.feed(vStr);
  if (text) appendProxyLog('CONTENT: ' + text);
  for (const tc of toolCalls) {
    appendProxyLog('TOOL_CALL: ' + tc.name + ' | ' + JSON.stringify(tc.arguments));
  }
  return { text, toolCalls };
}

function formatType(v: any): string {
  if (!v || typeof v !== 'object') return 'any';
  if (v.$ref) return 'object';
  const t = v.type || 'any';
  if (t === 'array' && v.items) return `${formatType(v.items)}[]`;
  if (t === 'object' && v.properties) {
    const nested = Object.entries(v.properties)
      .map(([nk, nv]: [string, any]) => `${nk}: ${formatType(nv)}`)
      .join(', ');
    return `{${nested}}`;
  }
  if (Array.isArray(v.enum) && v.enum.length > 0) {
    return v.enum.map((e: any) => JSON.stringify(e)).join(' | ');
  }
  return t;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    
    let toolsInfo = '';
    if (body.tools && body.tools.length > 0) {
      const toolSchemas = body.tools.map((tool: any) => {
        const func = tool.function || {};
        const name = func.name || 'unknown';
        const params = func.parameters || {};
        const required = params.required || [];
        const properties = params.properties || {};

        let paramsStr = '';
        if (Object.keys(properties).length > 0) {
          const paramDetails = Object.entries(properties)
            .map(([k, v]: [string, any]) => `${k}: ${formatType(v)}`)
            .join(', ');
          paramsStr = ` (${paramDetails})`;
        }

        return `- ${name}${paramsStr}${required.length ? ` [required: ${required.join(', ')}]` : ''}`;
      }).join('\n');

      toolsInfo = `\n\nAVAILABLE TOOLS:\n${toolSchemas}\n\nIMPORTANT: Use only the tool names listed above. Do NOT use invented names.\n`;
    }
    
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
              assistantContent = (assistantContent ? assistantContent + toolCallStr : '\n' + toolCallStr.trim());
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

    const finalPrompt = toolsInfo
      ? `${TOOL_CALL_INSTRUCTION}${toolsInfo}\n\n${systemPrompt}\n${prompt}`
      : systemPrompt
        ? `${systemPrompt}\n\n${prompt}`
        : `${prompt}`;
    
    appendPromptLog(finalPrompt);
    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Acquire the global Qwen chat mutex to prevent concurrent generations.
    // The Qwen backend only allows one active generation per session; without
    // this lock, parallel requests would race and one would get:
    //   "Bad_Request: The chat is in progress!"
    const releaseChatLock = await qwenChatMutex.acquire();

    // Retry logic with exponential backoff for "chat is in progress" errors
    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 3;
    let retryDelay = 500;
    while (retries > 0) {
      try {
        // If it's a new session, force parent_message_id to null
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, isNewSession ? null : undefined);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break; // Success
      } catch (err: any) {
        retries--;
        if (retries === 0) {
          releaseChatLock();
          throw err;
        }
        let useDelay = retryDelay;
        if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
          useDelay = err.retryAfterMs;
        }
        const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
        if (!isRetryable) {
          releaseChatLock();
          throw err;
        }
        console.warn(`[Chat] Qwen request failed, retrying in ${useDelay}ms... (${retries} left)`);
        await new Promise(r => setTimeout(r, useDelay));
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
    }

    const completionId = 'chatcmpl-' + randomUUID();

    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      const state: StreamState = {
        currentThoughtIndex: 0,
        reasoningBuffer: '',
        lastFullContent: '',
        targetResponseId: null,
        toolParser: new StreamingToolParser(),
        completionTokens: 0,
        promptTokens: Math.ceil(finalPrompt.length / 3.5)
      };
      const toolCallsOut: any[] = [];
      let buffer = '';
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
            const output = processQwenChunk(chunk, state, uiSessionId);
            if (output?.reasoningText) {
              // reasoning already in state.reasoningBuffer
            } else if (output) {
              if (output.text) appendProxyLog('CONTENT: ' + output.text);
              for (const tc of output.toolCalls) {
                toolCallsOut.push({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                });
              }
            }
          } catch (e) {
          }
        }
      }
      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        if (upstreamError.message.toLowerCase().includes('not exist')) {
          clearCachedHeaders();
        }
        releaseChatLock();
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = state.toolParser.flush();
      if (remainingText) {
        state.lastFullContent += remainingText;
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

      const usage = {
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_tokens: state.promptTokens + state.completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : state.lastFullContent };
      if (state.reasoningBuffer) message.reasoning_content = state.reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      appendProxyLog('FINAL message.content: ' + (message.content || '(null)'));
      appendProxyLog('FINAL message.tool_calls: ' + JSON.stringify(message.tool_calls || []));
      flushDebugLogs();

      releaseChatLock();
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
      
      const state: StreamState = {
        currentThoughtIndex: 0,
        reasoningBuffer: '',
        lastFullContent: '',
        targetResponseId: null,
        toolParser: new StreamingToolParser(),
        completionTokens: 0,
        promptTokens: Math.ceil(finalPrompt.length / 3.5)
      };
      let buffer = '';
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
            const output = processQwenChunk(chunk, state, uiSessionId);
            if (output?.reasoningText) {
              await writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [makeChoice({ reasoning_content: output.reasoningText })]
              });
            } else if (output) {
              if (output.text) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ content: output.text })]
                });
              }
              for (const tc of output.toolCalls) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({
                    tool_calls: [{
                      index: state.toolParser.getEmittedToolCallCount() - output.toolCalls.length + output.toolCalls.indexOf(tc),
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                    }]
                  })]
                });
              }
            }
          } catch (e) {
          }
        }
      }
      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        if (upstreamError.message.toLowerCase().includes('not exist')) {
          clearCachedHeaders();
        }
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
      const { text: remainingText, toolCalls: remainingToolCalls } = state.toolParser.flush();
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
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: state.toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
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
  
      // Send finish reason
      const usage = {
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_tokens: state.promptTokens + state.completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = state.toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
  
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
        releaseChatLock();
        flushDebugLogs();
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
