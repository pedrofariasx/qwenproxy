import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { textContainsToolCallStart } from '../tools/toolcall-tags.js';
import { isDegenerateAnswer, canFastReleaseGuard } from '../utils/degenerate-answer.js';
import { isOverloadMessage } from '../utils/overload-detector.js';
import { isDailyQuotaAssistantMessage, couldBeDailyQuotaAssistantMessagePrefix } from '../utils/qwen-quota-message.js';
import { parseQwenProviderError, parseQwenProviderBody, emptyQwenResponseError, qwenErrorBody } from '../utils/qwen-provider-error.js';
import type { QwenProviderError } from '../utils/qwen-provider-error.js';
import { removeStream, getStream } from '../core/stream-registry.js';
import { recordToolCall } from '../core/tool-call-debug.js';
import { recordToolCallEmission } from '../core/tool-call-registry.js';
import { updateSessionParent, markHistoryComplete, markHistoryIncomplete, fetchQwenChatHistory } from '../services/qwen.js';
import { countTokens } from '../core/tokenizer.js';
import { isTruncatedResponse } from '../utils/truncation-detector.js';
import { config } from '../core/config.js';

async function resolveResponseError(error: QwenProviderError | undefined, content: string, toolCount: number, completionId: string, chatId: string, parentId?: string | null, signal?: AbortSignal): Promise<QwenProviderError | null> {
  if (error) return error;
  if (content || toolCount > 0) return null;
  markHistoryIncomplete(chatId);
  const entry = getStream(completionId);
  if (entry && parentId && !signal?.aborted) {
    try {
      const history = await fetchQwenChatHistory(chatId, entry.headers, entry.accountId, 10, signal);
      const message = history.messages.find(item => item.role === 'assistant' && item.id === parentId);
      const fromHistory = parseQwenProviderError({ error: message?.error });
      if (fromHistory) return fromHistory;
    } catch (error) {
      console.warn('[Chat] Empty response history lookup failed:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  return emptyQwenResponseError();
}

export interface StreamHandlerContext {
  stream: ReadableStream;
  completionId: string;
  model: string;
  uiSessionId: string;
  hasTools: boolean;
  tools: any[];
  finalPrompt: string;
  streamOptions?: { include_usage?: boolean };
  /** Called exactly once when the response stream has fully finished. */
  onComplete?: () => void;
  onUsage?: (promptTokens: number, completionTokens: number, failed?: boolean) => void;
  /**
   * Enables the streaming degenerate-answer guard: all emitted chunks are held
   * back until either the buffer grows past a threshold or the upstream ends.
   * If the final answer turns out degenerate ("Yes"), the held bytes are
   * discarded and the response is re-generated via this hook.
   */
  onDegenerateRetry?: () => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  /**
   * Called once when the model SIGNALLED a tool call (opened a <tool_call> tag)
   * but no parseable tool call was produced by the end of the stream. Lets the
   * caller regenerate once with a corrective directive instead of silently
   * dropping the tool call.
   */
  onToolCallRetry?: () => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  onUpdateMemberRetry?: () => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  onOverloadRetry?: () => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  onDailyQuota?: (accountId: string, retryAllowed?: boolean) => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  onProviderRetry?: () => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
  /**
   * Called when a response was cut off / truncated (e.g. unclosed code fence or token limit)
   * to automatically continue generation on the same chat without requiring the user to send "continue".
   */
  onAutoContinue?: (chatId: string, parentId: string) => Promise<{ stream: ReadableStream; uiSessionId: string } | null>;
}

export function handleStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
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
    let completionTokens = 0;
    let promptTokens = 0;
    // Micro-buffer: coalesce many tiny SSE writes into fewer socket writes to cut
    // syscall overhead on long responses. Ordering is preserved because EVERY write
    // (content, reasoning, events, [DONE]) goes through this single buffer.
    let writeBuffer = '';
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    const WRITE_FLUSH_BYTES = 8192;
    const WRITE_FLUSH_MS = 3;

    // Streaming degenerate guard: while active, all output is held instead of
    // being written, and only released once enough content has accumulated or
    // the upstream stream ends. A degenerate final answer can then be discarded
    // and regenerated before the client ever sees it.
    const GUARD_HOLD_BYTES = 800;
    let guardActive = !!ctx.onDegenerateRetry || !!ctx.onToolCallRetry || !!ctx.onUpdateMemberRetry || !!ctx.onOverloadRetry;
    let heldOutput = '';
    let quotaProbeActive = true;
    let quotaHeldOutput = '';
    let meaningfulOutput = false;
    let succeeded = false;

    let activeStream: ReadableStream | null = ctx.stream;
    let activeReader: ReadableStreamDefaultReader<any> | null = null;
    const clientSignal = (c.req.raw as any)?.signal as AbortSignal | undefined;
    const clientAborted = () => !!clientSignal?.aborted;
    const releaseActiveStream = (reason: string) => {
      const r = activeReader;
      const s = activeStream;
      activeStream = null;
      activeReader = null;
      if (r) {
        r.cancel(reason).catch(() => {});
      } else {
        s?.cancel(reason).catch(() => {});
      }
    };
    const onClientAbort = () => releaseActiveStream('client aborted stream');
    if (clientSignal) {
      if (clientSignal.aborted) queueMicrotask(onClientAbort);
      else clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }

    const releaseGuard = () => {
      if (!guardActive) return;
      guardActive = false;
      if (heldOutput) {
        writeBuffer = heldOutput + writeBuffer;
        heldOutput = '';
      }
    };

    const flushWrites = () => {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (guardActive) {
        if (heldOutput.length > GUARD_HOLD_BYTES) releaseGuard();
        return;
      }
      if (writeBuffer) {
        const data = writeBuffer;
        writeBuffer = '';
        streamWriter.write(data);
      }
    };

    const bufferedWrite = (data: string) => {
      if (guardActive) {
        heldOutput += data;
        // Safety: never hold a long answer hostage — release once it is clearly
        // not a terse degenerate reply.
        if (heldOutput.length >= GUARD_HOLD_BYTES) {
          releaseGuard();
        }
        return;
      }
      writeBuffer += data;
      if (writeBuffer.length >= WRITE_FLUSH_BYTES) {
        flushWrites();
      } else if (!writeTimer) {
        writeTimer = setTimeout(flushWrites, WRITE_FLUSH_MS);
      }
    };

    const releaseQuotaProbe = () => {
      if (!quotaProbeActive) return;
      quotaProbeActive = false;
      if (quotaHeldOutput) {
        bufferedWrite(quotaHeldOutput);
        quotaHeldOutput = '';
      }
    };

    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval);
        }
      }, 15000);

      const writeEvent = (data: any) => {
        bufferedWrite(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      const emittedStreamingToolIds = new Set<string>();
      // Dedup by call CONTENT (name+arguments), not just id: on the rare
      // content-rewrite path the parser can re-emit the same tool call with a
      // fresh id, which would surface as a duplicate tool call to the client.
      const emittedStreamingToolSignatures = new Set<string>();

      const emitStreamingToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }, index: number) => {
        if (emittedStreamingToolIds.has(tc.id)) return;
        const argsStr = typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments ?? {});
        const signature = `${tc.name}\u0000${argsStr}`;
        if (emittedStreamingToolSignatures.has(signature)) return;
        emittedStreamingToolIds.add(tc.id);
        emittedStreamingToolSignatures.add(signature);
        recordToolCallEmission(ctx.uiSessionId, tc.id, tc.name, argsStr);
        const toolCallChunk = `data: ${JSON.stringify({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: argsStr }
            }]
          })]
        })}\n\n`;
        recordToolCall(ctx.completionId, 'streaming', toolCallChunk);
        bufferedWrite(toolCallChunk);
      };

      const createdTimestamp = Math.floor(Date.now() / 1000);

      // Pre-compute the constant parts of the per-chunk SSE envelope once, and use a
      // lightweight manual escaper instead of JSON.stringify().slice() on every chunk.
      const contentPrefix = `data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":${JSON.stringify(ctx.model)},"choices":[{"index":0,"delta":{"content":"`;
      const reasoningPrefix = `data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":${JSON.stringify(ctx.model)},"choices":[{"index":0,"delta":{"reasoning_content":"`;
      const chunkSuffix = `"},"logprobs":null,"finish_reason":null}]}\n\n`;

      // Detects chars that need JSON string escaping: backslash, double-quote, and
      // control characters (U+0000–U+001F). Control chars are intentionally matched.
      // eslint-disable-next-line no-control-regex
      const ESCAPE_RE = /[\\"\u0000-\u001f]/;
      const escapeJsonString = (s: string) => {
        // Cheap check: most LLM text chunks have no chars needing escaping.
        if (!ESCAPE_RE.test(s)) return s;
        return JSON.stringify(s).slice(1, -1);
      };

      let firstPayloadFlushed = false;
      let sawUpdateMemberSignal = false;
      let updateMemberRetried = false;
      let sawOverloadSignal = false;
      let overloadRetried = false;
      const estimatedPromptTokens = countTokens(ctx.finalPrompt);
      const fastWriteContent = (content: string) => {
        // Once a tool call has been streamed, never send more content chunks:
        // OpenAI clients treat assistant content AFTER tool_calls as an error
        // (and the model should stop after </tool_call> anyway).
        if (emittedStreamingToolIds.size > 0) return;
        const payload = contentPrefix + escapeJsonString(content) + chunkSuffix;
        if (quotaProbeActive) {
          if (couldBeDailyQuotaAssistantMessagePrefix(lastFullContent)) {
            quotaHeldOutput += payload;
            return;
          }
          releaseQuotaProbe();
        }
        if (content) meaningfulOutput = true;
        bufferedWrite(payload);
        if (!firstPayloadFlushed) { firstPayloadFlushed = true; flushWrites(); }
      };

      const fastWriteReasoning = (content: string) => {
        if (content) meaningfulOutput = true;
        bufferedWrite(reasoningPrefix + escapeJsonString(content) + chunkSuffix);
        if (!firstPayloadFlushed) { firstPayloadFlushed = true; flushWrites(); }
      };

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        session_id: ctx.uiSessionId,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });
      // Flush the opening role event immediately so clients see the stream begin.
      flushWrites();

      const decoder = new TextDecoder();
      let _reasoningBuffer = '';
      let lastFullContent = '';
      let contentLength = 0;
      let contentSuffix = '';
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      let currentThoughtIndex = 0;
      let toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
      let sawToolCallSignal = false;
      let toolCallRetried = false;
      let bufferChunks: string[] = [];
      let bufferLen = 0;
      let lineStart = 0;
      let upstreamFinishReason: string | null = null;
      let providerError: QwenProviderError | undefined;
      let nonSseBody = '';
      completionTokens = 0;
      promptTokens = estimatedPromptTokens;

      const resetStreamState = () => {
        _reasoningBuffer = '';
        lastFullContent = '';
        contentLength = 0;
        contentSuffix = '';
        targetResponseId = null;
        targetResponseIdSet = false;
        currentThoughtIndex = 0;
        toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
        sawToolCallSignal = false;
        bufferChunks = [];
        bufferLen = 0;
        lineStart = 0;
        upstreamFinishReason = null;
        providerError = undefined;
        nonSseBody = '';
        meaningfulOutput = false;
        completionTokens = 0;
        promptTokens = estimatedPromptTokens;
        firstPayloadFlushed = false;
        sawUpdateMemberSignal = false;
        updateMemberRetried = false;
        sawOverloadSignal = false;
        overloadRetried = false;
        heldOutput = '';
        quotaHeldOutput = '';
        quotaProbeActive = true;
        guardActive = !!ctx.onDegenerateRetry || !!ctx.onToolCallRetry || !!ctx.onUpdateMemberRetry || !!ctx.onOverloadRetry;
      };

      const readUpstream = async (stream: ReadableStream) => {
        const reader = stream.getReader() as ReadableStreamDefaultReader<any>;
        activeReader = reader;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const decoded = decoder.decode(value, { stream: true });
            bufferChunks.push(decoded);
            bufferLen += decoded.length;

            if (decoded.includes('\n')) {
              const fullBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
              processLines(fullBuffer);

              const remaining = fullBuffer.substring(lineStart);
              bufferChunks.length = 0;
              if (remaining) {
                bufferChunks.push(remaining);
                bufferLen = remaining.length;
              } else {
                bufferLen = 0;
              }
              lineStart = 0;
              if (providerError) { void reader.cancel('upstream error').catch(() => {}); break; }
            }
          }

          if (bufferLen > 0) {
            const finalBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
            processLines(finalBuffer + '\n');
          }
          providerError ??= parseQwenProviderBody(nonSseBody) ?? undefined;
        } catch {
          if (!clientAborted()) providerError = { code: 'UpstreamReadFailed', message: 'Failed to read the Qwen response.', status: 502, retryable: true, dailyQuota: false };
        } finally {
          activeReader = null;
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
      };

      const processLines = (fullBuffer: string) => {
        let pos = lineStart;
        while (pos < fullBuffer.length) {
          const newlineIdx = fullBuffer.indexOf('\n', pos);
          if (newlineIdx === -1) {
            lineStart = pos;
            return;
          }
          const line = fullBuffer.substring(pos, newlineIdx);
          pos = newlineIdx + 1;
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || /^(event|id|retry):/.test(trimmed)) continue;
          if (!trimmed.startsWith('data:')) { nonSseBody = (nonSseBody + line + '\n').slice(0, 8192); continue; }
          const dataStr = trimmed.slice(5).trimStart();
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
                targetResponseIdSet = true;
              }
              updateSessionParent(ctx.uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id && !targetResponseIdSet) {
              targetResponseId = chunk.response_id;
              targetResponseIdSet = true;
              updateSessionParent(ctx.uiSessionId, chunk.response_id);
            }

            if (!chunk.response_id || !targetResponseId || chunk.response_id === targetResponseId) {
              providerError ??= parseQwenProviderError(chunk) ?? undefined;
            }
            if (providerError) continue;

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
              upstreamFinishReason = chunk.choices[0].finish_reason;
            }

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              if (delta.extra?.update_member) {
                sawUpdateMemberSignal = true;
              }
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra?.summary_thought?.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'think') {
                isThinkingChunk = true;
                if (delta.content) {
                  vStr = delta.content;
                  foundStr = true;
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  if (!sawOverloadSignal && isOverloadMessage(newContent)) {
                    sawOverloadSignal = true;
                  }
                  const result = getIncrementalDelta(lastFullContent, newContent, contentLength, contentSuffix);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    contentLength = result.contentLength;
                    contentSuffix = result.contentSuffix;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                _reasoningBuffer += vStr;
                if (guardActive && _reasoningBuffer.length >= 60) {
                  releaseGuard();
                }
                fastWriteReasoning(vStr);
              } else {
                if (guardActive && !sawOverloadSignal && canFastReleaseGuard(lastFullContent)) {
                  releaseGuard();
                }
                if (ctx.hasTools && toolParser) {
                  const { text, toolCalls } = toolParser.feed(vStr);
                  if (toolParser.isInsideTool() || textContainsToolCallStart(vStr)) {
                    sawToolCallSignal = true;
                  }
                  if (text) {
                    if (looksLikeUnwrappedToolCall(text)) {
                      const unwrappedToolCalls = parseUnwrappedToolCalls(text);
                      const baseIndex = toolParser.getEmittedToolCallCount();
                      for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
                        const tc = unwrappedToolCalls[idx];
                        emitStreamingToolCall(tc, baseIndex + idx);
                      }
                    } else {
                      fastWriteContent(text);
                    }
                  }
                  for (let idx = 0; idx < toolCalls.length; idx++) {
                    emitStreamingToolCall(toolCalls[idx], toolParser.getEmittedToolCallCount() - toolCalls.length + idx);
                  }
                } else {
                  if (vStr) fastWriteContent(vStr);
                }
              }
            }
          } catch (e) {
            if (dataStr.length > 10) {
              console.warn(`[Chat] SSE parse error for chunk (${dataStr.length} chars):`, (e as Error).message);
            }
          }
        }
        lineStart = pos;
      };

      const finishProviderError = (error: QwenProviderError, hideNotice = false) => {
        if (hideNotice) {
          heldOutput = '';
          writeBuffer = '';
          quotaHeldOutput = '';
          quotaProbeActive = false;
        } else releaseQuotaProbe();
        releaseGuard();
        flushWrites();
        writeEvent(qwenErrorBody(error));
        bufferedWrite('data: [DONE]\n\n');
        flushWrites();
      };

      const quotaAccounts = new Set<string>();
      let providerRetriesLeft = 1;
      const recoverResponse = async (retryAllowed = true): Promise<boolean> => {
        while (!clientAborted()) {
          let error = await resolveResponseError(providerError, lastFullContent, emittedStreamingToolIds.size, ctx.completionId, ctx.uiSessionId, targetResponseId, clientSignal);
          if (!error && emittedStreamingToolIds.size === 0 && isDailyQuotaAssistantMessage(lastFullContent)) {
            error = { code: 'RateLimited', message: 'Qwen daily chat quota exhausted; no eligible recovery response is available.', status: 429, retryable: false, dailyQuota: true };
          }
          if (clientAborted()) return false;
          if (!error) return true;
          markHistoryIncomplete(ctx.uiSessionId);
          let retried: { stream: ReadableStream; uiSessionId: string } | null = null;
          const accountId = getStream(ctx.completionId)?.accountId;
          const canReplay = retryAllowed && emittedStreamingToolIds.size === 0 && !meaningfulOutput;
          try {
            if (error.dailyQuota && accountId && accountId !== 'guest' && accountId !== 'global' && !quotaAccounts.has(accountId) && ctx.onDailyQuota) {
              quotaAccounts.add(accountId);
              retried = await ctx.onDailyQuota(accountId, canReplay);
            } else if (error.retryable && canReplay && providerRetriesLeft > 0 && ctx.onProviderRetry) {
              providerRetriesLeft--;
              retried = await ctx.onProviderRetry();
            }
          } catch (failure) {
            console.warn('[Chat] Response recovery failed:', failure instanceof Error ? failure.name : 'UnknownError');
          }
          if (retried && (!canReplay || clientAborted())) {
            void retried.stream.cancel('recovery cancelled').catch(() => {});
            retried = null;
          }
          if (clientAborted()) return false;
          if (!retried) { finishProviderError(error, error.dailyQuota && isDailyQuotaAssistantMessage(lastFullContent)); return false; }
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          activeStream = retried.stream;
          try { await readUpstream(retried.stream); }
          catch (failure) {
            if (clientAborted()) return false;
            markHistoryIncomplete(ctx.uiSessionId);
            console.warn('[Chat] Recovery stream failed:', failure instanceof Error ? failure.name : 'UnknownError');
            finishProviderError({ code: 'UpstreamReadFailed', message: 'Failed to read the Qwen recovery response.', status: 502, retryable: false, dailyQuota: false });
            return false;
          }
        }
        return false;
      };

      await readUpstream(ctx.stream);
      if (!await recoverResponse()) return;
      if (toolParser?.isInsideTool()) sawToolCallSignal = true;

      // Degenerate-answer guard: if the entire response is a terse
      // acknowledgment, discard the held bytes and regenerate once with a
      // corrective directive before the client ever sees it.
      if (
        guardActive &&
        ctx.onDegenerateRetry &&
        emittedStreamingToolIds.size === 0 &&
        isDegenerateAnswer(lastFullContent)
      ) {
        if (clientAborted()) return;
        console.warn(`[Chat] Streaming degenerate reply detected (${JSON.stringify(lastFullContent.slice(0, 40))}). Regenerating...`);
        const retried = await ctx.onDegenerateRetry();
        if (retried) {
          if (clientAborted()) {
            retried.stream.cancel('client aborted stream').catch(() => {});
            return;
          }
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          activeStream = retried.stream;
          await readUpstream(retried.stream);
          if (!await recoverResponse()) return;
          if (toolParser?.isInsideTool()) sawToolCallSignal = true;
        }
      }

      // Tool-call retry guard: the model opened a <tool_call> tag but produced
      // no parseable tool call. Regenerate once with a corrective directive so
      // the client gets a usable tool call (or a plain answer) instead of a
      // silently dropped, malformed one.
      if (
        ctx.onToolCallRetry &&
        ctx.hasTools &&
        toolParser &&
        !toolCallRetried &&
        emittedStreamingToolIds.size === 0 &&
        sawToolCallSignal &&
        guardActive
      ) {
        if (clientAborted()) return;
        console.warn('[Chat] Tool call attempted but unparseable. Regenerating with corrective directive...');
        toolCallRetried = true;
        const retried = await ctx.onToolCallRetry();
        if (retried) {
          if (clientAborted()) {
            retried.stream.cancel('client aborted stream').catch(() => {});
            return;
          }
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          activeStream = retried.stream;
          await readUpstream(retried.stream);
          if (!await recoverResponse()) return;
          if (toolParser?.isInsideTool()) sawToolCallSignal = true;
        }
      }

      if (
        ctx.onOverloadRetry &&
        !overloadRetried &&
        (sawOverloadSignal || isOverloadMessage(lastFullContent))
      ) {
        if (clientAborted()) return;
        overloadRetried = true;
        const retried = await ctx.onOverloadRetry();
        if (retried) {
          if (clientAborted()) {
            retried.stream.cancel('client aborted stream').catch(() => {});
            return;
          }
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          activeStream = retried.stream;
          await readUpstream(retried.stream);
          if (!await recoverResponse()) return;
          if (toolParser?.isInsideTool()) sawToolCallSignal = true;
        }
      }

      // Membership-limit guard: the upstream account hit a membership/usage
      // limit and asked us to update the member plan. Retry once with another
      // account so the client gets a normal answer instead of a dead-end.
      if (
        ctx.onUpdateMemberRetry &&
        !updateMemberRetried &&
        sawUpdateMemberSignal &&
        guardActive
      ) {
        if (clientAborted()) return;
        console.warn('[Chat] Account membership limit hit. Retrying with another account...');
        updateMemberRetried = true;
        const retried = await ctx.onUpdateMemberRetry();
        if (retried) {
          if (clientAborted()) {
            retried.stream.cancel('client aborted stream').catch(() => {});
            return;
          }
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          activeStream = retried.stream;
          await readUpstream(retried.stream);
          if (!await recoverResponse()) return;
          if (toolParser?.isInsideTool()) sawToolCallSignal = true;
        }
      }

      releaseQuotaProbe();

      // Flush whatever survived (the real answer or the fallback).
      releaseGuard();

      // Auto-continue guard: if the response was cut off / truncated (e.g. unclosed code fence
      // or upstream finish_reason: 'length'), seamlessly request continuation on the same chat
      // with parentId and keep streaming without breaking the client connection.
      let autoContinuesLeft = config.autoContinue.enabled ? config.autoContinue.maxContinues : 0;
      while (
        autoContinuesLeft > 0 &&
        ctx.onAutoContinue &&
        emittedStreamingToolIds.size === 0 &&
        isTruncatedResponse(lastFullContent, upstreamFinishReason)
      ) {
        autoContinuesLeft--;
        flushWrites();
        console.warn(`[Chat] Truncated response detected (unclosed code fence or finish_reason=length). Auto-continuing stream (${config.autoContinue.maxContinues - autoContinuesLeft}/${config.autoContinue.maxContinues})...`);
        if (clientAborted()) break;
        const continued = await ctx.onAutoContinue(ctx.uiSessionId, targetResponseId || '');
        if (!continued) break;
        if (clientAborted()) {
          continued.stream.cancel('client aborted stream').catch(() => {});
          break;
        }
        ctx.uiSessionId = continued.uiSessionId;
        activeStream = continued.stream;
        bufferChunks = [];
        bufferLen = 0;
        lineStart = 0;
        currentThoughtIndex = 0;
        lastFullContent = '';
        contentLength = 0;
        contentSuffix = '';
        targetResponseId = null;
        targetResponseIdSet = false;
        upstreamFinishReason = null;
        providerError = undefined;
        nonSseBody = '';
        quotaProbeActive = true;
        quotaHeldOutput = '';
        await readUpstream(continued.stream);
        if (!await recoverResponse(false)) return;
        releaseQuotaProbe();
      }

      if (toolParser) {
        const flushResult = toolParser.flush();
        if (flushResult.text) {
          if (ctx.hasTools && looksLikeUnwrappedToolCall(flushResult.text)) {
            const unwrappedToolCalls = parseUnwrappedToolCalls(flushResult.text);
            const baseIndex = toolParser.getEmittedToolCallCount();
            for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
              const tc = unwrappedToolCalls[idx];
              emitStreamingToolCall(tc, baseIndex + idx);
            }
          } else if (emittedStreamingToolIds.size === 0) {
            writeEvent({
              id: ctx.completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: ctx.model,
              choices: [makeChoice({ content: flushResult.text })]
            });
          }
        }
        for (let idx = 0; idx < flushResult.toolCalls.length; idx++) {
          emitStreamingToolCall(flushResult.toolCalls[idx], toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + idx);
        }
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : (upstreamFinishReason || 'stop');

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        session_id: ctx.uiSessionId,
        choices: [makeChoice({}, finalFinishReason)],
        ...(ctx.streamOptions?.include_usage ? {} : { usage })
      });

      if (ctx.streamOptions?.include_usage) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [],
          usage
        });
      }
      bufferedWrite('data: [DONE]\n\n');
      flushWrites();
      markHistoryComplete(ctx.uiSessionId);
      succeeded = true;
    } finally {
      if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort);
      releaseActiveStream('stream teardown');
      flushWrites();
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
      if (!succeeded) markHistoryIncomplete(ctx.uiSessionId);
      try { ctx.onUsage?.(promptTokens, completionTokens, !succeeded); }
      finally { ctx.onComplete?.(); }
    }
  });
}

export interface NonStreamingResult {
  providerError?: QwenProviderError;
  status: number;
  body: any;
  content: string;
  toolCalls: any[];
  degenerate: boolean;
  updateMember: boolean;
  overload: boolean;
  quotaLimited: boolean;
  quotaAccountId?: string;
  regenerated?: boolean;
  targetResponseId?: string | null;
  isTruncated?: boolean;
}

/**
 * Reads a completed (non-streaming) upstream response and returns both the
 * final body and the raw assistant content so callers can detect degenerate
 * replies ("Yes") and retry with a corrective directive.
 */
export async function collectNonStreamingResult(
  c: Context,
  stream: ReadableStream,
  completionId: string,
  model: string,
  uiSessionId: string,
  hasTools: boolean,
  tools: any[],
  onComplete?: () => void,
): Promise<NonStreamingResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const toolCallsOut: any[] = [];
  const seenToolCallIds = new Set<string>();
  const seenToolCallSignatures = new Set<string>();
  let buffer = '';
  let nonSseBody = '';
  let completed = false;
  const completeOnce = () => {
    if (completed) return;
    completed = true;
    onComplete?.();
  };

  const pushToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
    if (seenToolCallIds.has(tc.id)) return;
    seenToolCallIds.add(tc.id);
    const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
    const signature = `${tc.name}\u0000${argsStr}`;
    if (seenToolCallSignatures.has(signature)) return;
    seenToolCallSignatures.add(signature);
    recordToolCallEmission(uiSessionId, tc.id, tc.name, argsStr);
    const entry = { id: tc.id, type: 'function', function: { name: tc.name, arguments: argsStr } };
    recordToolCall(completionId, 'non-streaming', JSON.stringify(entry));
    toolCallsOut.push(entry);
  };

  const qwenParser = new QwenStreamParser(uiSessionId, {
    tools: hasTools ? tools : [],
    onThinking: () => {},
    onToolCall: (tc) => {
      pushToolCall(tc);
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || /^(event|id|retry):/.test(trimmed)) continue;
        if (!trimmed.startsWith('data:')) { nonSseBody = (nonSseBody + line + '\n').slice(0, 8192); continue; }
        const dataStr = trimmed.slice(5).trimStart();
        if (dataStr === '[DONE]') continue;
        qwenParser.parseLine(dataStr);
      }
      if (qwenParser.state.upstreamError) {
        void reader.cancel('upstream error').catch(() => {});
        break;
      }
    }

    if (buffer.trimStart().startsWith('data:')) qwenParser.parseLine(buffer.trimStart().slice(5).trimStart());
    else if (!buffer.trimStart().startsWith(':')) nonSseBody = (nonSseBody + buffer).slice(0, 8192);

  } catch (error) {
    markHistoryIncomplete(uiSessionId);
    removeStream(completionId);
    completeOnce();
    throw error;
  } finally { reader.releaseLock(); }

  const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
  const parserState = qwenParser.state;
  let finalContent = parserState.lastFullContent;
  if (remainingText) finalContent += remainingText;
  for (const tc of remainingToolCalls) {
    pushToolCall(tc);
  }

  if (hasTools && toolCallsOut.length === 0) {
    for (const tc of parseUnwrappedToolCalls(finalContent)) {
      pushToolCall(tc);
    }
    if (toolCallsOut.length > 0) finalContent = '';
  }

  const providerError = await resolveResponseError(parserState.upstreamError ?? parseQwenProviderBody(nonSseBody) ?? undefined, finalContent, toolCallsOut.length, completionId, uiSessionId, parserState.targetResponseId, c.req?.raw?.signal);
  if (providerError) {
    const accountId = getStream(completionId)?.accountId;
    markHistoryIncomplete(uiSessionId);
    removeStream(completionId);
    completeOnce();
    return { status: providerError.status, body: qwenErrorBody(providerError), content: '', toolCalls: [], degenerate: false, updateMember: false, overload: false, quotaLimited: providerError.dailyQuota, quotaAccountId: accountId, providerError, targetResponseId: parserState.targetResponseId };
  }

  const usage = {
    prompt_tokens: parserState.promptTokens,
    completion_tokens: parserState.completionTokens,
    total_tokens: parserState.promptTokens + parserState.completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };
  const message: any = { role: 'assistant', content: toolCallsOut.length ? (finalContent || '') : finalContent };
  if (parserState.reasoningBuffer) message.reasoning_content = parserState.reasoningBuffer;
  if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
  if (toolCallsOut.length) message.tool_calls = toolCallsOut;

  const isTruncated = toolCallsOut.length === 0 && isTruncatedResponse(finalContent, parserState.finishReason);
  const finishReason = toolCallsOut.length ? 'tool_calls' : (isTruncated ? 'length' : (parserState.finishReason || 'stop'));

  const quotaLimited = toolCallsOut.length === 0 && isDailyQuotaAssistantMessage(finalContent);
  const quotaAccountId = quotaLimited ? getStream(completionId)?.accountId : undefined;
  removeStream(completionId);
  if (quotaLimited) {
    markHistoryIncomplete(uiSessionId);
    completeOnce();
    return {
      status: 429,
      body: { error: { message: 'Qwen daily chat quota exhausted; try again tomorrow.', type: 'rate_limit_error', code: 'RateLimited' } },
      content: finalContent,
      toolCalls: [],
      degenerate: false,
      updateMember: false,
      overload: false,
      quotaLimited: true,
      quotaAccountId,
    };
  }
  if (c.req?.raw?.signal?.aborted) markHistoryIncomplete(uiSessionId);
  else markHistoryComplete(uiSessionId);
  completeOnce();
  return {
    status: 200,
    body: {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      session_id: uiSessionId,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason
      }],
      usage
    },
    content: finalContent,
    toolCalls: toolCallsOut,
    degenerate: toolCallsOut.length === 0 && isDegenerateAnswer(finalContent),
    updateMember: parserState.updateMemberDetected,
    overload: parserState.overloadDetected,
    quotaLimited: false,
    targetResponseId: parserState.targetResponseId,
    isTruncated,
  };
}

export function handleNonStreamingResponse(
  c: Context,
  stream: ReadableStream,
  completionId: string,
  model: string,
  uiSessionId: string,
  hasTools: boolean,
  tools: any[],
): any {
  return (async () => {
    const result = await collectNonStreamingResult(c, stream, completionId, model, uiSessionId, hasTools, tools);
    if (result.status === 503) c.header('Retry-After', '2');
    return c.json(result.body, result.status as any);
  })();
}
