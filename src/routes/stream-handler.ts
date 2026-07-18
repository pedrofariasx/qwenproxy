import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta, parseQwenErrorPayload } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { removeStream } from '../core/stream-registry.js';
import { updateSessionParent } from '../services/qwen.js';

export interface StreamHandlerContext {
  stream: ReadableStream;
  completionId: string;
  model: string;
  uiSessionId: string;
  hasTools: boolean;
  tools: any[];
  finalPrompt: string;
  streamOptions?: { include_usage?: boolean };
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
    // Micro-buffer: coalesce many tiny SSE writes into fewer socket writes to cut
    // syscall overhead on long responses. Ordering is preserved because EVERY write
    // (content, reasoning, events, [DONE]) goes through this single buffer.
    let writeBuffer = '';
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    const WRITE_FLUSH_BYTES = 8192;
    const WRITE_FLUSH_MS = 3;

    const flushWrites = () => {
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      if (writeBuffer) {
        const data = writeBuffer;
        writeBuffer = '';
        streamWriter.write(data);
      }
    };

    const bufferedWrite = (data: string) => {
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

      const emitStreamingToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }, index: number) => {
        if (emittedStreamingToolIds.has(tc.id)) return;
        emittedStreamingToolIds.add(tc.id);
        bufferedWrite(`data: ${JSON.stringify({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }]
          })]
        })}\n\n`);
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
      const fastWriteContent = (content: string) => {
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
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });
      // Flush the opening role event immediately so clients see the stream begin.
      flushWrites();

      const reader = ctx.stream.getReader();
      const decoder = new TextDecoder();
      let _reasoningBuffer = '';
      let lastFullContent = '';
      let contentLength = 0;
      let contentSuffix = '';
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      let currentThoughtIndex = 0;
      const toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
      const bufferChunks: string[] = [];
      let bufferLen = 0;
      let lineStart = 0;
      let completionTokens = 0;
      let promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5);

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

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
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
                fastWriteReasoning(vStr);
              } else {
                if (ctx.hasTools && toolParser) {
                  const { text, toolCalls } = toolParser.feed(vStr);
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
                  for (const tc of toolCalls) {
                    emitStreamingToolCall(tc, toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc));
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
          } else {
            writeEvent({
              id: ctx.completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: ctx.model,
              choices: [makeChoice({ content: flushResult.text })]
            });
          }
        }
        for (const tc of flushResult.toolCalls) {
          const idx = toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc);
          emitStreamingToolCall(tc, idx);
        }
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
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
    } finally {
      flushWrites();
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
    }
  });
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
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const toolCallsOut: any[] = [];
    const seenToolCallIds = new Set<string>();
    let buffer = '';

    const pushToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (seenToolCallIds.has(tc.id)) return;
      seenToolCallIds.add(tc.id);
      toolCallsOut.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      });
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
      return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
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
    const message: any = { role: 'assistant', content: toolCallsOut.length ? null : finalContent };
    if (parserState.reasoningBuffer) message.reasoning_content = parserState.reasoningBuffer;
    if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
    if (toolCallsOut.length) message.tool_calls = toolCallsOut;

    removeStream(completionId);
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
      }],
      usage
    });
  })();
}
