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
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { Mutex } from '../services/playwright.ts';
import {
  appendConversationTurn,
  buildPromptMessages,
  ensureChat,
  inferModeFromModel,
  mergeChatMessages
} from '../storage/chat-store.ts';

// Global mutex that serializes ALL Qwen chat completions requests.
// The Qwen web backend is stateful: it only allows one generation at a time
// per session. Concurrent requests to the same session produce:
//   "Bad_Request: The chat is in progress!"
// A single global lock is the safest approach because the proxy currently
// shares one browser session (and therefore one Qwen auth context).
const qwenChatMutex = new Mutex();

function buildModeSystemPrompt(mode: 'chat' | 'coder'): string {
  if (mode === 'coder') {
    return [
      'You are Qwen Coder, a coding-focused assistant.',
      'Prioritize software engineering, debugging, refactoring, code review, architecture, and technical accuracy.',
      'When the user is asking about code, respond with precise, structured, implementation-oriented answers.',
      'Prefer code blocks, diffs, command examples, and concrete steps over vague explanations.',
      'Use tools when they materially improve the answer, especially for reading files, inspecting code, or validating assumptions.',
      'If the task is not code-related, still answer directly, but keep the response concise and technically grounded.'
    ].join('\n');
  }

  return [
    'You are Qwen Chat, a general-purpose assistant.',
    'Prioritize conversation, explanation, reasoning, planning, and multimodal understanding.',
    'Be clear, direct, and helpful.',
    'Use tools when they improve accuracy or let you inspect external context.',
    'If the user is asking for code, answer with practical code-oriented guidance, but keep the mode general-purpose.'
  ].join('\n');
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

function normalizeUpstreamToolCall(candidate: any, delta: any): { id: string; name: string; arguments: Record<string, unknown> } | null {
  const functionPayload = candidate?.function ?? candidate ?? {};
  const name = functionPayload?.name || candidate?.name || delta?.tool_name || delta?.mcp_name;
  if (!name || typeof name !== 'string') return null;

  const rawArgs = functionPayload?.arguments ?? candidate?.arguments ?? {};

  if (typeof rawArgs === 'string') {
    const parsed = robustParseJSON(rawArgs);
    if (parsed && typeof parsed === 'object') {
      return {
        id: candidate?.id || `call_${uuidv4()}`,
        name,
        arguments: parsed as Record<string, unknown>
      };
    }

    try {
      const fallback = JSON.parse(rawArgs);
      if (fallback && typeof fallback === 'object') {
        return {
          id: candidate?.id || `call_${uuidv4()}`,
          name,
          arguments: fallback as Record<string, unknown>
        };
      }
    } catch {
      return null;
    }
  }

  if (rawArgs && typeof rawArgs === 'object') {
    return {
      id: candidate?.id || `call_${uuidv4()}`,
      name,
      arguments: rawArgs as Record<string, unknown>
    };
  }

  return {
    id: candidate?.id || `call_${uuidv4()}`,
    name,
    arguments: {}
  };
}

function collectUpstreamToolCalls(delta: any): { id: string; name: string; arguments: Record<string, unknown> }[] {
  const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

  if (Array.isArray(delta?.tool_calls)) {
    for (const candidate of delta.tool_calls) {
      const normalized = normalizeUpstreamToolCall(candidate, delta);
      if (normalized) calls.push(normalized);
    }
  }

  if (delta?.function_call) {
    const normalized = normalizeUpstreamToolCall(delta.function_call, delta);
    if (normalized) calls.push(normalized);
  }

  return calls;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const bodyAny = body as any;
    const requestedChatId = bodyAny.chat_id || bodyAny.conversation_id;
    const requestedMode = bodyAny.mode === 'coder' ? 'coder' : (bodyAny.mode === 'chat' ? 'chat' : inferModeFromModel(body.model));
    const conversation = await ensureChat(requestedChatId, { model: body.model, mode: requestedMode });
    const chatId = conversation.id;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    const mergedMessages = mergeChatMessages(conversation.messages, messages);
    const promptBuild = buildPromptMessages(conversation, mergedMessages);
    const promptMessages = promptBuild.messages;
    let systemPrompt = '';
    const modeSystemPrompt = buildModeSystemPrompt(conversation.mode || requestedMode);
    systemPrompt += `${modeSystemPrompt}\n\n`;
    
    for (let i = 0; i < promptMessages.length; i++) {
      const msg = promptMessages[i];
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
    const toolChoice = bodyAny.tool_choice;
    const shouldInjectTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0 && toolChoice !== 'none';

    if (shouldInjectTools) {
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
      
      if (toolChoice && typeof toolChoice === 'object' && toolChoice.function) {
        const forcedTool = toolChoice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      } else if (toolChoice === 'required') {
        systemPrompt += `CRITICAL: You MUST call at least one tool in this response if a tool is relevant.\n\n`;
      }
    }

    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !conversation.messages.some(m => m.role === 'assistant');
    const explicitChatId = !!requestedChatId;
    const forcedParentId = conversation.lastResponseId
      ?? (explicitChatId && isNewSession ? null : undefined);

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
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, forcedParentId);
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
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();
    c.header('X-QwenProxy-Chat-Id', chatId);

    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      const toolCallsOut: any[] = [];
      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let upstreamError: { message: string; status: number } | null = null;
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

            if (chunk?.error || chunk?.success === false) {
              upstreamError = parseQwenErrorPayload(dataStr) || {
                message: typeof chunk?.error === 'string'
                  ? chunk.error
                  : chunk?.error?.message || 'Qwen returned an error',
                status: 502
              };
              break;
            }

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
            const upstreamToolCalls = collectUpstreamToolCalls(chunk?.choices?.[0]?.delta);

            for (const tc of upstreamToolCalls) {
              toolCallsOut.push({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments)
                }
              });
            }

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

        if (upstreamError) {
          break;
        }
      }

      if (upstreamError) {
        releaseChatLock();
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const upstreamPayloadError = parseQwenErrorPayload(buffer);
      if (upstreamPayloadError) {
        releaseChatLock();
        return c.json({ error: { message: upstreamPayloadError.message } }, upstreamPayloadError.status as any);
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

      const savedTurn = await appendConversationTurn(chatId, messages, message, body.model, targetResponseId);

      releaseChatLock();
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        chat_id: chatId,
        response_id: targetResponseId,
        last_message_id: savedTurn.lastMessageId,
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
    c.header('X-QwenProxy-Chat-Id', chatId);

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
      const toolCallsOut: any[] = [];

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let upstreamError: { message: string; status: number } | null = null;

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

            if (chunk?.error || chunk?.success === false) {
              upstreamError = parseQwenErrorPayload(dataStr) || {
                message: typeof chunk?.error === 'string'
                  ? chunk.error
                  : chunk?.error?.message || 'Qwen returned an error',
                status: 502
              };
              break;
            }

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
            const upstreamToolCalls = collectUpstreamToolCalls(chunk?.choices?.[0]?.delta);

            for (const tc of upstreamToolCalls) {
              const outIndex = toolCallsOut.length;
              const normalized = {
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments)
                }
              };
              toolCallsOut.push(normalized);
              await writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [makeChoice({
                  tool_calls: [{
                    index: outIndex,
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
                  const outIndex = toolCallsOut.length;
                  toolCallsOut.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  });
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index: outIndex,
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

        if (upstreamError) {
          break;
        }
      }

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

      const upstreamPayloadError = parseQwenErrorPayload(buffer);
      if (upstreamPayloadError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: upstreamPayloadError.message })]
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
        const outIndex = toolCallsOut.length;
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: outIndex,
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
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = toolCallsOut.length > 0 ? 'tool_calls' : 'stop';

      const assistantMessage: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
      if (reasoningBuffer) assistantMessage.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) assistantMessage.tool_calls = toolCallsOut.map((tc, idx) => ({ ...tc, index: idx }));

      const savedTurn = await appendConversationTurn(chatId, messages, assistantMessage, body.model, targetResponseId);
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        response_id: targetResponseId,
        last_message_id: savedTurn.lastMessageId,
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
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
