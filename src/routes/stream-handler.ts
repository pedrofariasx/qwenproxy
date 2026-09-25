import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta, parseQwenErrorPayload } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { textContainsToolCallStart } from '../tools/toolcall-tags.js';
import { isDegenerateAnswer, canFastReleaseGuard } from '../utils/degenerate-answer.js';
import { removeStream } from '../core/stream-registry.js';
import { recordToolCall } from '../core/tool-call-debug.js';
import { recordToolCallEmission } from '../core/tool-call-registry.js';
import { updateSessionParent, markHistoryComplete } from '../services/qwen.js';
import { countTokens } from '../core/tokenizer.js';
import { isTruncatedResponse } from '../utils/truncation-detector.js';
import { config } from '../core/config.js';

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
  onUsage?: (promptTokens: number, completionTokens: number) => void;
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
    let guardActive = !!ctx.onDegenerateRetry || !!ctx.onToolCallRetry || !!ctx.onUpdateMemberRetry;
    let heldOutput = '';

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
      const estimatedPromptTokens = countTokens(ctx.finalPrompt);
      const fastWriteContent = (content: string) => {
        // Once a tool call has been streamed, never send more content chunks:
        // OpenAI clients treat assistant content AFTER tool_calls as an error
        // (and the model should stop after </tool_call> anyway).
        if (emittedStreamingToolIds.size > 0) return;
        bufferedWrite(contentPrefix + escapeJsonString(content) + chunkSuffix);
        if (!firstPayloadFlushed) { firstPayloadFlushed = true; flushWrites(); }
      };

      const fastWriteReasoning = (content: string) => {
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
        completionTokens = 0;
        promptTokens = estimatedPromptTokens;
        firstPayloadFlushed = false;
        sawUpdateMemberSignal = false;
        updateMemberRetried = false;
        heldOutput = '';
        guardActive = !!ctx.onDegenerateRetry || !!ctx.onToolCallRetry || !!ctx.onUpdateMemberRetry;
      };

      const readUpstream = async (stream: ReadableStream) => {
        const reader = stream.getReader();
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
          }
        }

        if (bufferLen > 0) {
          const finalBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
          processLines(finalBuffer);
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            bufferedWrite('data: [DONE]\n');
            continue;
          }

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
                if (guardActive && canFastReleaseGuard(lastFullContent)) {
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

      await readUpstream(ctx.stream);
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
        console.warn(`[Chat] Streaming degenerate reply detected (${JSON.stringify(lastFullContent.slice(0, 40))}). Regenerating...`);
        const retried = await ctx.onDegenerateRetry();
        if (retried) {
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          await readUpstream(retried.stream);
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
        console.warn('[Chat] Tool call attempted but unparseable. Regenerating with corrective directive...');
        toolCallRetried = true;
        const retried = await ctx.onToolCallRetry();
        if (retried) {
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          await readUpstream(retried.stream);
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
        console.warn('[Chat] Account membership limit hit. Retrying with another account...');
        updateMemberRetried = true;
        const retried = await ctx.onUpdateMemberRetry();
        if (retried) {
          ctx.uiSessionId = retried.uiSessionId;
          resetStreamState();
          await readUpstream(retried.stream);
          if (toolParser?.isInsideTool()) sawToolCallSignal = true;
        }
      }

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
        console.warn(`[Chat] Truncated response detected (unclosed code fence or finish_reason=length). Auto-continuing stream (${config.autoContinue.maxContinues - autoContinuesLeft}/${config.autoContinue.maxContinues})...`);
        const continued = await ctx.onAutoContinue(ctx.uiSessionId, targetResponseId || '');
        if (!continued) break;
        ctx.uiSessionId = continued.uiSessionId;
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
        await readUpstream(continued.stream);
      }

      const tailBuffer = bufferChunks.length > 0
        ? (bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('')).substring(lineStart)
        : '';

      const upstreamError = parseQwenErrorPayload(tailBuffer);
      if (upstreamError) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({}, 'stop')]
        });
        bufferedWrite('data: [DONE]\n\n');
        flushWrites();
        return;
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
    } finally {
      flushWrites();
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
      ctx.onUsage?.(promptTokens, completionTokens);
      ctx.onComplete?.();
    }
  });
}

export interface NonStreamingResult {
  status: number;
  body: any;
  content: string;
  toolCalls: any[];
  degenerate: boolean;
  updateMember: boolean;
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
      qwenParser.parseLine(dataStr);
    }
  }

  const upstreamError = parseQwenErrorPayload(buffer);
  if (upstreamError) {
    removeStream(completionId);
    completeOnce();
    return {
      status: upstreamError.status,
      body: { error: { message: upstreamError.message } },
      content: '',
      toolCalls: [],
      degenerate: false,
      updateMember: false,
    };
  }

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

  removeStream(completionId);
  markHistoryComplete(uiSessionId);
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
    return c.json(result.body, result.status as any);
  })();
}
