import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
process.env.BROWSER_IDLE_HIBERNATE_MS = '0';
delete process.env.API_KEY;
delete process.env.AUTH_REQUIRED;

const originalCwd = process.cwd();
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenproxy-tool-context-'));
process.chdir(testDirectory);

const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { listSessions } = await import('../../core/database.js');
const { resetAllSessions } = await import('../../services/session-manager.js');

addAccount('context-fixture@example.test', 'fixture-password');

after(() => {
  closeDatabase();
  process.chdir(originalCwd);
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

interface FixtureMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

async function forwardedToolCycle(messages: FixtureMessage[], systems: string[] = ['', ''], toolsets: any[][] = [[], []]) {
  resetAllSessions();
  process.env.TEST_SESSION_ID = 'tool-context-chat';
  const captured: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    captured.push(JSON.parse(String(init?.body || '{}')));
    const responseId = `context-parent-${captured.length}`;
    return new Response([
      `data: ${JSON.stringify({ 'response.created': { response_id: responseId } })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Fixture response completed.', phase: 'answer' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { status: 200 });
  };
  try {
    const turns = [
      [{ role: 'user', content: 'Read documentation and report its settings.' }],
      messages,
    ];
    for (const [index, turn] of turns.entries()) {
      const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.7-plus', user: 'context-fixture-session', messages: [{ role: 'system', content: systems[index] }, ...turn], tools: toolsets[index] }),
      }));
      assert.equal(response.status, 200, await response.clone().text());
      await response.text();
    }
    assert.equal(captured.length, 2);
    assert.equal(captured[1].parent_id, 'context-parent-1');
    const prompt = captured[1].messages[0].content as string;
    if (messages.some(message => message.role === 'tool')) assert.ok(prompt.includes('RECENT TOOL ACTIVITY'));
    if (systems[0] === systems[1] && systems[0] && JSON.stringify(toolsets[0]) === JSON.stringify(toolsets[1])) assert.ok(!prompt.includes(systems[0]), 'unchanged instructions must not be appended to the server conversation again');
    return prompt;
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_SESSION_ID;
  }
}

test('economical continuation forwards the complete documentation tool result', async () => {
  const content = 'Navigation header\n'.repeat(600) +
    '"limit": { "context": 131072, "output": 16384 }\nlimit.context\n' + 'Document tail\n'.repeat(300);
  const expectedStrings = ['limit.context', '"context": 131072', '"output": 16384'];
  const prompt = await forwardedToolCycle([
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-docs', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://kilo.ai/docs/code-with-ai/agents/custom-models"}' } }] },
    { role: 'tool', name: 'webfetch', tool_call_id: 'read-docs', content },
  ]);
  assert.ok(prompt.includes(content), 'the entire tool result must reach the upstream request');
  for (const expected of expectedStrings) assert.ok(prompt.includes(expected));
});

test('unchanged system instructions are sent once in a pinned conversation', async () => {
  const instructions = 'Distinct system instruction.\n'.repeat(60);
  const prompt = await forwardedToolCycle([
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: 'Fixture response completed.' },
    { role: 'user', content: 'Continue the same task.' },
  ], [instructions, instructions]);
  assert.ok(prompt.includes('User: Continue the same task.'));
});

test('changed system instructions reach the next pinned conversation turn', async () => {
  const prompt = await forwardedToolCycle([
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: 'Fixture response completed.' },
    { role: 'user', content: 'Continue the same task.' },
  ], ['Old task constraint.', 'Updated task constraint.']);
  assert.ok(prompt.includes('Updated task constraint.'));
});

test('instruction hashes are saved in the persistent session store', async () => {
  await forwardedToolCycle([
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: 'Fixture response completed.' },
    { role: 'user', content: 'Continue the same task.' },
  ], ['Stable instruction.', 'Stable instruction.']);
  assert.equal(listSessions()[0]?.instructions_hash?.length, 64);
});

test('unchanged tool schemas are not appended again and changed schemas are delivered', async () => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'SCHEMA_SENTINEL '.repeat(80), parameters: { type: 'object', properties: { file: { type: 'string' } } } } }];
  const messages = [
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: 'Fixture response completed.' },
    { role: 'user', content: 'Continue the same task.' },
  ];
  const same = await forwardedToolCycle(messages, ['Stable instruction.', 'Stable instruction.'], [tools, tools]);
  assert.ok(!same.includes('SCHEMA_SENTINEL'));
  const updated = [{ ...tools[0], function: { ...tools[0].function, description: 'CHANGED_SCHEMA_SENTINEL' } }];
  const changed = await forwardedToolCycle(messages, ['Stable instruction.', 'Stable instruction.'], [tools, updated]);
  assert.ok(changed.includes('CHANGED_SCHEMA_SENTINEL'));
});

test('economical continuation preserves long tool arguments and assistant text', async () => {
  const argumentsJson = JSON.stringify({ patch: 'changed line\n'.repeat(90) + 'ARGUMENT_TAIL_SENTINEL' });
  const narrative = 'Relevant decision\n'.repeat(80) + 'ASSISTANT_TAIL_SENTINEL';
  const prompt = await forwardedToolCycle([
    { role: 'user', content: 'Read documentation and report its settings.' },
    { role: 'assistant', content: narrative, tool_calls: [{ id: 'patch-document', type: 'function', function: { name: 'apply_patch', arguments: argumentsJson } }] },
    { role: 'tool', name: 'apply_patch', tool_call_id: 'patch-document', content: 'Applied the complete patch.' },
    { role: 'user', content: 'Explain the applied changes.' },
  ]);
  assert.ok(prompt.includes(argumentsJson));
  assert.ok(prompt.includes(narrative));
  assert.ok(prompt.includes('User: Explain the applied changes.'));
});

test('economical continuation preserves every result in a cycle longer than six tool calls', async () => {
  const messages: FixtureMessage[] = [{ role: 'user', content: 'Read documentation and report its settings.' }];
  const results = Array.from({ length: 9 }, (_, index) => `Distinct result ${index}: value-${index}`);
  for (const [index, result] of results.entries()) {
    messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `read-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ file: `fixture-${index}.txt` }) } }] },
      { role: 'tool', name: 'read', tool_call_id: `read-${index}`, content: result },
    );
  }
  const prompt = await forwardedToolCycle(messages);
  for (const result of results) assert.ok(prompt.includes(result));
});
