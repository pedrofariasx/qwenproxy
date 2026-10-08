import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { get_encoding } from 'tiktoken';

const cwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-serialization-'));
process.chdir(directory);
Object.assign(process.env, { TEST_MOCK_PLAYWRIGHT: 'true', QWEN_DIRECT_FETCH: 'false', HYBRID_SESSION_VERIFY: 'false', AUTO_CONTINUE: 'false', WARM_POOL_SIZE: '0', BROWSER_IDLE_HIBERNATE_MS: '0' });
for (const key of ['API_KEY', 'AUTH_REQUIRED', 'USER_API_KEYS', 'TEST_SESSION_ID']) delete process.env[key];
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { resetAllSessions } = await import('../../services/session-manager.js');
const { setModelContextWindow } = await import('../../core/model-registry.js');
const { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } = await import('../../tools/toolcall-tags.js');
addAccount('serialization@example.invalid', 'fixture-password', 'serialization-account');
const nativeFetch = globalThis.fetch;
let payloads: any[] = [];
let uploads: number[] = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  assert.equal(new URL(url).hostname, 'chat.qwen.ai');
  if (url.endsWith('/getstsToken')) {
    uploads.push(Number(JSON.parse(String(init?.body)).filesize));
    return Response.json({ success: true, data: { access_key_id: 'fixture', access_key_secret: 'fixture', security_token: 'fixture', file_url: `https://fixture.invalid/upload-${uploads.length}.png`, file_path: 'fixture', file_id: `fixture-${uploads.length}`, bucketname: 'fixture', region: 'oss-cn-hangzhou', endpoint: 'oss-cn-hangzhou.aliyuncs.com' } });
  }
  assert.ok(url.includes('/completions?'), 'Only controlled provider operations are expected');
  payloads.push(JSON.parse(String(init?.body)));
  const responseId = `serialization-response-${payloads.length}`;
  return new Response(`data: ${JSON.stringify({ 'response.created': { response_id: responseId } })}\n\n`
    + `data: ${JSON.stringify({ response_id: responseId, choices: [{ delta: { content: 'The controlled response is complete. Every relevant fixture check can now inspect the forwarded request.', phase: 'answer' }, finish_reason: 'stop' }] })}\n\n`
    + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
beforeEach(() => { resetAllSessions(); payloads = []; uploads = []; });
after(async () => {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase(); process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true });
});
const argsOne = '{ "query": "ARG_ONE_SENTINEL", "integer": 9007199254740993, "tail": "' + 'a'.repeat(600) + '" }';
const argsTwo = JSON.stringify({ patch: 'changed line\n'.repeat(80) + 'ARG_TWO_TAIL' });
const resultOne = 'RESULT_ONE_START\n' + 'document section\n'.repeat(90) + 'RESULT_ONE_TAIL';
const resultTwo = 'RESULT_TWO_START\n' + 'patch output\n'.repeat(90) + 'RESULT_TWO_TAIL';
const tools = ['read_doc', 'apply_patch'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
async function send(messages: unknown[], window: number) {
  setModelContextWindow('qwen3.7-plus', window);
  const response = await nativeFetch(origin + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.7-plus', user: 'serialization-fixture', reasoning_effort: 'none', tools, messages }),
  });
  const body = await response.json();
  return { response, body, prompt: payloads[0]?.messages[0].content as string | undefined };
}
function toolPayloads(prompt: string): any[] {
  return prompt.split(TOOL_CALL_OPEN).slice(1).flatMap(part => {
    try { return [JSON.parse(part.split(TOOL_CALL_CLOSE)[0].trim())]; } catch { return []; }
  });
}
for (const truncated of [false, true]) {
  test(`HTTP ${truncated ? 'truncated' : 'ordinary'} bootstrap preserves complete tool calls and results`, async () => {
    const messages = [
      { role: 'system', content: 'SYS_ONLY_ONCE_SENTINEL' },
      { role: 'developer', content: 'DEV_ONLY_ONCE_SENTINEL' },
      ...(truncated ? [{ role: 'user', content: 'old conversational text '.repeat(6000) + 'OLD_DROPPED_TAIL' }] : []),
      { role: 'user', content: 'Read the document and apply the complete patch.' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call-one', type: 'function', function: { name: 'read_doc', arguments: argsOne } },
        { id: 'call-two', type: 'function', function: { name: 'apply_patch', arguments: argsTwo } },
      ] },
      { role: 'tool', name: 'read_doc', tool_call_id: 'call-one', content: resultOne },
      { role: 'tool', tool_call_id: 'call-two', content: resultTwo },
      { role: 'user', content: 'Conclude after both tools.' },
    ];
    const { response, prompt } = await send(messages, truncated ? 4096 : 100000);
    assert.equal(response.status, 200);
    assert.equal(payloads.length, 1);
    assert.ok(prompt);
    const calls = toolPayloads(prompt).filter(call => ['call-one', 'call-two'].includes(call.id));
    assert.deepEqual(calls.map(call => [call.id, call.type, call.name]), [['call-one', 'function', 'read_doc'], ['call-two', 'function', 'apply_patch']]);
    assert.ok(prompt.includes(argsOne), 'Valid JSON argument bytes, including a large integer literal, must be preserved');
    assert.ok(prompt.includes(argsTwo));
    assert.ok(prompt.includes(resultOne));
    assert.ok(prompt.includes(resultTwo));
    assert.match(prompt, /Tool Response \(read_doc\):[^]*call-one/);
    assert.match(prompt, /Tool Response \(apply_patch\):[^]*call-two/);
    assert.equal(prompt.split('SYS_ONLY_ONCE_SENTINEL').length - 1, 1);
    assert.equal(prompt.split('DEV_ONLY_ONCE_SENTINEL').length - 1, 1);
    assert.equal(prompt.split('# TOOL CALLING FORMAT (MANDATORY)').length - 1, 1);
    assert.ok(prompt.indexOf(resultOne) < prompt.indexOf(resultTwo));
    assert.ok(prompt.includes('User: Conclude after both tools.'));
    if (truncated) assert.ok(!prompt.includes('OLD_DROPPED_TAIL'), 'The HTTP request must actually use the truncation branch');
  });
}

test('an oversized current tool group is rejected before any completion request', async () => {
  const { response, body } = await send([
    { role: 'assistant', content: null, tool_calls: [{ id: 'oversized-call', type: 'function', function: { name: 'read_doc', arguments: JSON.stringify({ text: 'large complete argument '.repeat(2500) }) } }] },
    { role: 'tool', name: 'read_doc', tool_call_id: 'oversized-call', content: 'The current tool result must keep its complete call.' },
  ], 2048);
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'ContextWindowExceeded');
  assert.equal(payloads.length, 0);
});


test('HTTP truncation forwards retained media without uploading an omitted media message', async () => {
  const image = (size: number) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.alloc(size).toString('base64') } });
  const { response, prompt } = await send([
    { role: 'assistant', content: [{ type: 'text', text: 'old media history '.repeat(6000) + 'OLD_MEDIA_TAIL' }, image(17)] },
    { role: 'user', content: [{ type: 'text', text: 'CURRENT_MEDIA_TEXT' }, image(23)] },
  ], 4096);
  assert.equal(response.status, 200);
  assert.deepEqual(uploads, [23]);
  assert.equal(payloads[0].messages[0].files.length, 1);
  assert.equal(payloads[0].messages[0].files[0].size, 23);
  assert.ok(prompt?.includes('CURRENT_MEDIA_TEXT'));
  assert.ok(!prompt?.includes('OLD_MEDIA_TAIL'));
});

test('HTTP truncation bounds a partial Unicode message by serialized tokens', async () => {
  const { response, prompt } = await send([{ role: 'user', content: 'Пример текста с кириллицей и эмодзи 🚀. '.repeat(5000) }], 4096);
  assert.equal(response.status, 200);
  assert.ok(prompt?.includes('[Truncated]'));
  const encoding = get_encoding('cl100k_base');
  try { assert.ok(encoding.encode(prompt!).length <= 4096); } finally { encoding.free(); }
});

test('HTTP history retains invalid JSON argument strings, names and legacy function roles', async () => {
  const invalid = '{"incomplete":';
  const { response, prompt } = await send([
    { role: 'assistant', name: 'historical-agent', content: '  Exact assistant spacing.  ', tool_calls: [{ id: 'legacy-call', type: 'function', function: { name: 'read_doc', arguments: invalid } }] },
    { role: 'function', name: 'read_doc', tool_call_id: 'legacy-call', content: '  Exact result spacing.  ' },
  ], 100000);
  assert.equal(response.status, 200);
  assert.ok(prompt?.includes('Assistant (historical-agent):   Exact assistant spacing.  '));
  assert.ok(prompt?.includes('Function Response (read_doc): [tool_call_id: "legacy-call"]\n  Exact result spacing.  '));
  assert.equal(toolPayloads(prompt!).find(call => call.id === 'legacy-call')?.arguments, invalid);
});

test('system-only input is serialized once without a fabricated user copy', async () => {
  const { response, prompt } = await send([{ role: 'system', content: 'SYSTEM_ONLY_INPUT' }], 100000);
  assert.equal(response.status, 200);
  assert.equal(prompt?.split('SYSTEM_ONLY_INPUT').length, 2);
  assert.ok(!prompt?.includes('User: SYSTEM_ONLY_INPUT'));
});


test('literal role names cannot resolve through the role-label prototype', async () => {
  const { serializeConversationMessages } = await import('../../utils/conversation-serialization.js');
  assert.equal(serializeConversationMessages([{ role: 'toString', content: 'literal role text' }]), 'toString: literal role text');
});


test('stream creation only prepares bootstrap when it is used and releases a failed preparation lease', async () => {
  const { createQwenStream } = await import('../../services/stream-creator.js');
  const { setSession, getSession } = await import('../../services/session-manager.js');
  const { getAccountActiveLoad } = await import('../../core/account-manager.js');
  const { ConversationContextError } = await import('../../utils/conversation-serialization.js');
  setSession('lazy-bootstrap-session', { chatId: 'lazy-bootstrap-chat', accountId: 'serialization-account', parentId: 'confirmed-parent',
    headers: { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture', 'bx-umidtoken': 'fixture', 'bx-v': 'fixture' }, historyComplete: true, updatedAt: Date.now() });
  let preparations = 0;
  const options = { sessionKey: 'lazy-bootstrap-session', economicalPrompt: 'User: Cached valid turn.', prepareBootstrap: () => {
    preparations++; throw new ConversationContextError('fixture unused bootstrap exceeds context');
  } };
  const result = await createQwenStream('unused bootstrap', false, 'qwen3.7-plus', null, 'serialization-account', undefined, undefined, options);
  await new Response(result.stream).text();
  assert.equal(preparations, 0);
  assert.equal(payloads[0].messages[0].content, 'User: Cached valid turn.');
  const before = structuredClone(getSession('lazy-bootstrap-session'));
  await assert.rejects(createQwenStream('unused bootstrap', false, 'qwen3.7-plus', null, 'serialization-account', undefined, undefined,
    { ...options, forceBootstrap: true }), ConversationContextError);
  assert.equal(preparations, 1);
  assert.equal(payloads.length, 1);
  assert.equal(getAccountActiveLoad('serialization-account'), 0);
  assert.deepEqual(getSession('lazy-bootstrap-session'), before);
});

test('media on a retained instruction message is not silently discarded', async () => {
  const { response, prompt } = await send([
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM_MEDIA_TEXT' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.alloc(17).toString('base64') } }] },
    { role: 'user', content: 'Use the retained image.' },
  ], 100000);
  assert.equal(response.status, 200);
  assert.deepEqual(uploads, [17]);
  assert.equal(payloads[0].messages[0].files.length, 1);
  assert.equal(payloads[0].messages[0].files[0].size, 17);
  assert.ok(prompt?.includes('SYSTEM_MEDIA_TEXT'));
});
