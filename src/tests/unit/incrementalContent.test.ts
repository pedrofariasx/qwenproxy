import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.WARM_POOL_SIZE = '0';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
process.env.AUTO_CONTINUE = 'false';
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-incremental-'));
process.chdir(directory);
const { handleStreamingResponse, collectNonStreamingResult } = await import('../../routes/stream-handler.js');
const { closeDatabase } = await import('../../core/database.js');
const { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } = await import('../../tools/toolcall-tags.js');
after(() => { closeDatabase(); process.chdir(originalCwd); fs.rmSync(directory, { recursive: true, force: true }); });

function upstream(parts: string[], bytewise = false) {
  const rows = [
    { 'response.created': { response_id: 'selected' } },
    { response_id: 'alternate', choices: [{ delta: { phase: 'answer', content: 'Ignore this response.' } }] },
    ...parts.map(content => ({ response_id: 'selected', choices: [{ delta: { phase: 'answer', status: 'typing', content } }] })),
  ];
  const bytes = new TextEncoder().encode(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n');
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
}

async function result(parts: string[], streaming: boolean, tools: any[] = [], bytewise = false) {
  const server = new Hono();
  server.get('/', c => streaming
    ? handleStreamingResponse(c, { stream: upstream(parts, bytewise), completionId: 'fixture-completion', model: 'qwen3.8-omni-flash', uiSessionId: 'fixture-chat', hasTools: tools.length > 0, tools, finalPrompt: 'Fixture prompt' })
    : collectNonStreamingResult(c, upstream(parts, bytewise), 'fixture-completion', 'qwen3.8-omni-flash', 'fixture-chat', tools.length > 0, tools).then(value => c.json(value.body, value.status as any)));
  const response = await server.request('/');
  assert.equal(response.status, 200);
  const raw = await response.text();
  const chunks = streaming ? raw.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6))) : [JSON.parse(raw)];
  const content = streaming ? chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('') : chunks[0].choices[0].message.content;
  const calls = streaming ? chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || []) : chunks[0].choices[0].message.tool_calls || [];
  return { content, calls };
}

for (const streaming of [false, true]) {
  for (const fixture of [
    { name: 'captured Qwen prefix overlap', parts: ['S', 'SE_PROBE_', '773', '388'], expected: 'SSE_PROBE_773388' },
    { name: 'identical chunks', parts: ['ha', 'ha', ' answer'], expected: 'haha answer' },
    { name: 'repeated whitespace', parts: [' ', ' ', 'answer'], expected: '  answer' },
    { name: 'a delta beginning with all prior content', parts: ['foo', 'foo bar'], expected: 'foofoo bar' },
    { name: 'repeated newlines and Unicode', parts: ['\n', '\n', 'Привет 🌍'], expected: '\n\nПривет 🌍' },
  ]) test(`${streaming ? 'SSE' : 'JSON'} retains ${fixture.name}`, async () => {
    assert.equal((await result(fixture.parts, streaming)).content, fixture.expected);
  });
  test(`${streaming ? 'SSE' : 'JSON'} retains Unicode across individual network bytes`, async () => {
    assert.equal((await result(['🌍', '🌍', ' привет'], streaming, [], true)).content, '🌍🌍 привет');
  });
  test(`${streaming ? 'SSE' : 'JSON'} retains repeated tool arguments`, async () => {
    const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }];
    const value = await result([TOOL_CALL_OPEN, '{"name":"echo","arguments":{"text":"S', 'SE  ', '🌍🌍"}}', TOOL_CALL_CLOSE], streaming, tools, true);
    assert.equal(value.calls.length, 1);
    assert.equal(value.calls[0].function.name, 'echo');
    assert.deepEqual(JSON.parse(value.calls[0].function.arguments), { text: 'SSE  🌍🌍' });
    if (streaming) assert.equal(value.content, '');
  });
}
