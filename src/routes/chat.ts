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
import {
  acquireHybridRequestWindow,
  createQwenStream,
  finalizeHybridConversation,
  markHybridRequestCooldown,
  prepareHybridConversation,
  RetryableQwenStreamError,
} from '../services/qwen.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import type { InvalidToolCall } from '../tools/parser.ts';
import type { ParsedToolCall } from '../tools/types.ts';

function isDebugEnabled(): boolean {
  return process.env.DEBUG_QWEN_PROXY === '1';
}

function getIncrementalDelta(oldStr: string, newStr: string): string {
  if (!oldStr) return newStr;
  if (newStr === oldStr) return '';
  if (newStr.startsWith(oldStr)) return newStr.substring(oldStr.length);
  // If it doesn't start with oldStr, assume it's a delta
  return newStr;
}

type MessageContentPart = {
  text?: string;
};

function serializeMessageContent(content: Message['content']): string {
  if (Array.isArray(content)) {
    return content
      .map((part: MessageContentPart | unknown) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const typedPart = part as MessageContentPart;
          return typedPart.text || JSON.stringify(part);
        }

        return JSON.stringify(part);
      })
      .join('\n');
  }

  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }

  return content || '';
}

function formatConversationMessage(msg: Message, content: string): string {
  if (msg.role === 'user') {
    return `User: ${content}\n\n`;
  }

  if (msg.role === 'assistant') {
    let assistantContent = content;

    if (msg.reasoning_content) {
      assistantContent = `<think>\n${msg.reasoning_content}\n</think>\n${assistantContent}`;
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        let args = toolCall.function?.arguments || '{}';
        if (typeof args !== 'string') {
          args = JSON.stringify(args);
        }

        assistantContent += `\n<tool_call>{"name": "${toolCall.function?.name}", "arguments": ${args}}</tool_call>`;
      }
    }

    return `Assistant: ${assistantContent.trim()}\n\n`;
  }

  if (msg.role === 'tool' || msg.role === 'function') {
    return `Tool Response (${msg.name || 'tool'}): ${content}\n\n`;
  }

  return `${msg.role}: ${content}\n\n`;
}

function getOpencodeChatKey(c: Context): string | null {
  const chatKey = c.req.header('x-opencode-chat-key');
  if (!chatKey) {
    return null;
  }

  const normalizedChatKey = chatKey.trim();
  return normalizedChatKey.length > 0 ? normalizedChatKey : null;
}

class RetryableToolCallRepairError extends Error {
  readonly retryPrompt: string;

  constructor(retryPrompt: string) {
    super('Qwen emitted an invalid tool_call payload; requesting a corrected retry.');
    this.name = 'RetryableToolCallRepairError';
    this.retryPrompt = retryPrompt;
  }
}

function buildInvalidToolCallFallback(invalidToolCalls: InvalidToolCall[]): string {
  return invalidToolCalls.map((item) => `<tool_call>${item.raw}</tool_call>`).join('');
}

function buildToolCallRepairPrompt(invalidToolCalls: InvalidToolCall[]): string {
  const reasons = invalidToolCalls.map((item) => item.reason).join(', ');
  return [
    'Your immediately previous response attempted a tool call, but the JSON inside <tool_call>...</tool_call> was invalid and could not be parsed by the proxy.',
    `Detected issue types: ${reasons || 'invalid_payload'}.`,
    'Re-send ONLY the corrected tool call block.',
    'Rules:',
    '1. Output exactly one <tool_call>...</tool_call> block.',
    '2. Do not include markdown, explanation, or normal chat text.',
    '3. The JSON must contain a string field "name" and an object field "arguments".',
    '4. Preserve the same intent and arguments from your previous tool call, but make the JSON valid.',
  ].join('\n');
}

function isQwenRateLimitError(chunk: unknown): chunk is { error: { details?: string } } {
  if (typeof chunk !== 'object' || chunk === null || !('error' in chunk)) {
    return false;
  }

  const errorValue = (chunk as { error?: unknown }).error;
  if (typeof errorValue !== 'object' || errorValue === null) {
    return false;
  }

  const details = (errorValue as { details?: unknown }).details;
  return typeof details === 'string' && details.includes('Request rate increased too quickly');
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    
    // Extract the prompt
    const messages = body.messages || [];
    let systemPrompt = '';
    const messageEntries: string[] = [];
    
    for (const msg of messages) {
      const contentStr = serializeMessageContent(msg.content);

      if (msg.role === 'system') {
        systemPrompt += contentStr + '\n\n';
      } else {
        messageEntries.push(formatConversationMessage(msg, contentStr));
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
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
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const opencodeChatKey = getOpencodeChatKey(c);
    const conversationPlan = prepareHybridConversation(opencodeChatKey, body.model, systemPrompt, messageEntries);
    const finalPrompt = conversationPlan.prompt;
    const releaseHybridWindow = await acquireHybridRequestWindow(
      conversationPlan.key,
      conversationPlan.reusedSession,
    );

    const isThinkingModel = !body.model.includes('no-thinking');

    const streamOptions = {
      chatSessionId: conversationPlan.chatSessionId,
      parentMessageId: conversationPlan.parentMessageId,
      forceFreshChat: !conversationPlan.reusedSession,
      pageKey: opencodeChatKey,
    };

    let initialStreamResult!: Awaited<ReturnType<typeof createQwenStream>>;
    let fetchAttempt = 1;
    const maxFetchAttempts = 4;

    // Retry loop para a chamada INICIAL também (evita falha imediata em "chat in progress")
    while (fetchAttempt <= maxFetchAttempts) {
      try {
        initialStreamResult = await createQwenStream(finalPrompt, isThinkingModel, body.model, streamOptions);
        break; // Sucesso: sai do loop
      } catch (error) {
        if (error instanceof RetryableQwenStreamError && fetchAttempt < maxFetchAttempts) {
          console.warn(`[QwenProxy] Retry ${fetchAttempt}/${maxFetchAttempts} para chamada inicial: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
          fetchAttempt += 1;
          continue;
        }
        // Não é retryable ou esgotou tentativas: propaga o erro
        markHybridRequestCooldown(conversationPlan.key, conversationPlan.reusedSession);
        releaseHybridWindow();
        throw error;
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const completionId = 'chatcmpl-' + uuidv4();

    return honoStream(c, async (streamWriter: any) => {
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
      
      let inThinkingState = false;
      let currentThoughtIndex = 0;
      
      let reasoningBuffer = '';
      let assistantContentBuffer = '';
      const emittedToolCalls: ParsedToolCall[] = [];
      let latestResponseId: string | null = conversationPlan.parentMessageId;
      let lastFullContent = '';
      const toolParser = new StreamingToolParser({ fallbackInvalidToolCallsToText: false });

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let debugChunkCount = 0;

      let activeChatSessionId = conversationPlan.chatSessionId;
      let streamDoneSent = false;
      let fetchAttempt = 1;
      const maxFetchAttempts = 4;
      let semanticRetryAttempt = 0;
      const maxSemanticRetryAttempts = 1;
      let currentStream = initialStreamResult.stream;
      activeChatSessionId = initialStreamResult.chatSessionId;

      // Renomeado para evitar conflito com o retry da chamada inicial
      let streamFetchAttempt = 1;
      const maxStreamFetchAttempts = 4;

      const emitAssistantText = async (text: string): Promise<void> => {
        if (!text) {
          return;
        }

        assistantContentBuffer += text;
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: text })]
        });
      };

      try {
        while (streamFetchAttempt <= maxStreamFetchAttempts) {
          try {
            const reader = currentStream.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });

              if (isDebugEnabled() && debugChunkCount < 5) {
                console.log(`[Qwen][Debug] Raw chunk ${debugChunkCount + 1}:`, JSON.stringify(buffer.slice(0, 1200)));
                debugChunkCount++;
              }

              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;

                const dataStr = trimmed.slice(6);
                if (dataStr === '[DONE]') {
                  continue;
                }

                let chunk: Record<string, unknown>;
                try {
                  chunk = JSON.parse(dataStr) as Record<string, unknown>;
                } catch {
                  continue;
                }

                if (isDebugEnabled() && debugChunkCount <= 5) {
                  console.log('[Qwen][Debug] Parsed event keys:', Object.keys(chunk));
                }

                if (isQwenRateLimitError(chunk)) {
                  const hasVisibleOutput = Boolean(reasoningBuffer || assistantContentBuffer || emittedToolCalls.length > 0);

                  if (!hasVisibleOutput && fetchAttempt < maxFetchAttempts) {
                    throw new RetryableQwenStreamError(
                      'Qwen rate limited the conversation reuse; retrying with backoff.',
                      1200 * fetchAttempt,
                    );
                  }

                  throw new Error(chunk.error.details || 'Qwen returned a stream error');
                }

                if (chunk['response.created'] && typeof chunk['response.created'] === 'object' && chunk['response.created'] !== null) {
                  const responseCreated = chunk['response.created'] as { response_id?: unknown };
                  if (typeof responseCreated.response_id === 'string') {
                    latestResponseId = responseCreated.response_id;
                  }
                } else if (typeof chunk.response_id === 'string') {
                  latestResponseId = chunk.response_id;
                }

                const usage = chunk.usage as { output_tokens?: number; input_tokens?: number } | undefined;
                if (usage) {
                  if (typeof usage.output_tokens === 'number') completionTokens = usage.output_tokens;
                  if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
                }

                let vStr = '';
                let foundStr = false;
                let isThinkingChunk = false;
                const chunkChoices = Array.isArray(chunk.choices) ? chunk.choices : [];
                const firstChoice = chunkChoices[0] as { delta?: Record<string, unknown> } | undefined;

                if (firstChoice?.delta) {
                  const delta = firstChoice.delta;

                  if (delta.phase === 'thinking_summary') {
                    isThinkingChunk = true;
                    const extra = delta.extra as { summary_thought?: { content?: string[] } } | undefined;
                    const thoughts = extra?.summary_thought?.content;
                    if (Array.isArray(thoughts) && thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join('\n');
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  } else if (delta.phase === 'answer') {
                    isThinkingChunk = false;
                    if (typeof delta.content === 'string') {
                      const newContent = delta.content;
                      vStr = getIncrementalDelta(lastFullContent, newContent);

                      if (vStr) {
                        lastFullContent += vStr;
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
                    const { text, toolCalls, invalidToolCalls } = toolParser.feed(vStr);

                    if (
                      invalidToolCalls.length > 0 &&
                      emittedToolCalls.length === 0 &&
                      toolCalls.length === 0 &&
                      semanticRetryAttempt < maxSemanticRetryAttempts &&
                      activeChatSessionId &&
                      latestResponseId
                    ) {
                      await reader.cancel();
                      throw new RetryableToolCallRepairError(buildToolCallRepairPrompt(invalidToolCalls));
                    }

                    if (text) {
                      await emitAssistantText(text);
                    }

                    if (invalidToolCalls.length > 0) {
                      await emitAssistantText(buildInvalidToolCallFallback(invalidToolCalls));
                    }

                    for (const tc of toolCalls) {
                      emittedToolCalls.push(tc);
                      await writeEvent({
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: body.model,
                        choices: [makeChoice({
                          tool_calls: [{
                            index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
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
              }
            }

            break;
          } catch (error) {
            if (error instanceof RetryableQwenStreamError && streamFetchAttempt < maxStreamFetchAttempts) {
              await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
              buffer = '';
              streamFetchAttempt += 1;
              const retryResult = await createQwenStream(finalPrompt, isThinkingModel, body.model, streamOptions);
              currentStream = retryResult.stream;
              activeChatSessionId = retryResult.chatSessionId;
              continue;
            }

            if (error instanceof RetryableToolCallRepairError && semanticRetryAttempt < maxSemanticRetryAttempts) {
              buffer = '';
              semanticRetryAttempt += 1;
              lastFullContent = '';
              currentThoughtIndex = 0;
              inThinkingState = false;

              const retryResult = await createQwenStream(
                error.retryPrompt,
                isThinkingModel,
                body.model,
                {
                  chatSessionId: activeChatSessionId,
                  parentMessageId: latestResponseId,
                  forceFreshChat: false,
                  pageKey: opencodeChatKey,
                },
              );

              currentStream = retryResult.stream;
              activeChatSessionId = retryResult.chatSessionId;
              continue;
            }

            throw error;
          }
        }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls, invalidToolCalls: remainingInvalidToolCalls } = toolParser.flush();
      if (remainingText) {
        await emitAssistantText(remainingText);
      }
      if (remainingInvalidToolCalls.length > 0) {
        await emitAssistantText(buildInvalidToolCallFallback(remainingInvalidToolCalls));
      }
      for (const tc of remainingToolCalls) {
        emittedToolCalls.push(tc);
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
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

      if (opencodeChatKey && activeChatSessionId && latestResponseId) {
        const assistantEntry = formatConversationMessage(
          {
            role: 'assistant',
            content: assistantContentBuffer,
            reasoning_content: reasoningBuffer || undefined,
            tool_calls: emittedToolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            })),
            tool_call_id: undefined,
            name: undefined,
          },
          assistantContentBuffer
        );

        finalizeHybridConversation(
          conversationPlan.key,
          body.model,
          systemPrompt,
          [...messageEntries, assistantEntry],
          activeChatSessionId,
          latestResponseId
        );
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
        usage: usage
      });
      if (!streamDoneSent) {
        await streamWriter.write('data: [DONE]\n\n');
      }
      } finally {
        markHybridRequestCooldown(conversationPlan.key, conversationPlan.reusedSession);
        releaseHybridWindow();
      }

    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    
    type StructuredError = {
      message: string;
      code: 'CHAT_IN_PROGRESS' | 'RATE_LIMITED' | 'INVALID_TOOL_CALL' | 'STREAM_ERROR' | 'UNKNOWN';
      retry_hint?: {
        should_retry: boolean;
        wait_seconds?: number;
        action?: 'wait_and_retry' | 'regenerate_prompt' | 'check_conversation_state';
      };
      debug_info?: Record<string, unknown>;
    };
    
    const structured: StructuredError = {
      message: err.message,
      code: 'UNKNOWN',
    };
    
    if (err instanceof RetryableQwenStreamError) {
      structured.code = 'CHAT_IN_PROGRESS';
      structured.retry_hint = {
        should_retry: true,
        wait_seconds: Math.ceil(err.retryAfterMs / 1000),
        action: 'wait_and_retry'
      };
    } else if (err.message?.includes('rate limit') || err.message?.includes('Request rate increased')) {
      structured.code = 'RATE_LIMITED';
      structured.retry_hint = {
        should_retry: true,
        wait_seconds: 30,
        action: 'wait_and_retry'
      };
    } else if (err.message?.includes('invalid tool') || err.message?.includes('RetryableToolCallRepairError')) {
      structured.code = 'INVALID_TOOL_CALL';
      structured.retry_hint = {
        should_retry: true,
        action: 'regenerate_prompt'
      };
    } else if (err.message?.includes('stream') || err.message?.includes('Failed to fetch')) {
      structured.code = 'STREAM_ERROR';
      structured.retry_hint = {
        should_retry: true,
        wait_seconds: 5,
        action: 'wait_and_retry'
      };
    }
    
    // Em debug mode, inclui info extra para diagnóstico
    if (isDebugEnabled()) {
      structured.debug_info = {
        stack: err.stack,
        timestamp: new Date().toISOString()
      };
    }
    
    return c.json({ error: structured }, 500);
  }
}
