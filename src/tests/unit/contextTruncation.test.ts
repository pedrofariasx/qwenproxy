import { test } from 'node:test';
import assert from 'node:assert';
import { estimateTokenCount, truncateMessages } from '../../utils/context-truncation.js';

test('estimateTokenCount: returns 0 for empty string', () => {
  assert.strictEqual(estimateTokenCount(''), 0);
});

test('estimateTokenCount: estimates tokens with tiktoken (cl100k_base)', () => {
  assert.strictEqual(estimateTokenCount('hello'), 1);
  assert.strictEqual(estimateTokenCount('a'.repeat(100)), 13);
  assert.strictEqual(estimateTokenCount('a'.repeat(250)), 32);
  assert.strictEqual(estimateTokenCount('a'.repeat(2500)), 313);
});

test('estimateTokenCount: handles single character', () => {
  assert.strictEqual(estimateTokenCount('x'), 1);
});

test('estimateTokenCount: short ASCII strings use a single token', () => {
  assert.strictEqual(estimateTokenCount('ab'), 1);
  assert.strictEqual(estimateTokenCount('abc'), 1);
  assert.strictEqual(estimateTokenCount('abcd'), 1);
});

test('truncateMessages: returns all messages when within context window', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].content, 'You are helpful.');
  assert.strictEqual(result[1].content, 'Hello');
  assert.strictEqual(result[2].content, 'Hi there!');
});

test('truncateMessages: preserves chronological order', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result[0].role, 'user');
  assert.strictEqual(result[0].content, 'first');
  assert.strictEqual(result[1].role, 'assistant');
  assert.strictEqual(result[2].role, 'user');
  assert.strictEqual(result[2].content, 'third');
});

test('truncateMessages: drops oldest messages first when exceeding context', () => {
  const largeContent = 'x'.repeat(5000);
  const messages = [
    { role: 'user', content: largeContent },
    { role: 'assistant', content: largeContent },
    { role: 'user', content: 'latest message' },
  ];
  const result = truncateMessages(messages, 2000);
  const lastMsg = result[result.length - 1];
  assert.ok(lastMsg.content.includes('latest message') || lastMsg.content.includes('[Truncated]'));
});

test('truncateMessages: rejects instructions that leave no conversation budget', () => {
  const messages = [
    { role: 'user', content: 'some content' },
  ];
  const systemPrompt = 'system instructions';
  assert.throws(() => truncateMessages(messages, 10, systemPrompt), /no room/);
});

test('truncateMessages: handles array content in messages', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
      ],
    },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].content.includes('hello'));
});

test('truncateMessages: handles null content', () => {
  const messages = [
    { role: 'user', content: null },
    { role: 'assistant', content: 'response' },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].content, '');
  assert.strictEqual(result[1].content, 'response');
});

test('truncateMessages: handles object content', () => {
  const messages = [
    { role: 'user', content: { structured: 'data', value: 42 } },
  ];
  const result = truncateMessages(messages, 100000);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].content.includes('structured'));
});

test('truncateMessages: truncates partially fitting message with marker', () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(10000) },
  ];
  const result = truncateMessages(messages, 1000);
  assert.strictEqual(result.length, 1);
  assert.ok(
    result[0].content.includes('[Truncated]') || result[0].content.length < 10000,
    'Should truncate or mark as truncated'
  );
});

test('truncateMessages: accounts for system prompt in available tokens', () => {
  const systemPrompt = 'x'.repeat(2000);
  const messages = [
    { role: 'user', content: 'short' },
  ];
  const withSystem = truncateMessages(messages, 2000, systemPrompt);
  const withoutSystem = truncateMessages(messages, 2000);
  assert.ok(withSystem.length <= withoutSystem.length);
});

test('truncateMessages: handles empty messages array', () => {
  const result = truncateMessages([], 100000);
  assert.strictEqual(result.length, 0);
});

test('truncateMessages: preserves earlier tool memory when truncating history', () => {
  const messages = [
    {
      role: 'assistant',
      content: 'I will inspect the file.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/a.txt' }) } }],
    },
    {
      role: 'tool',
      name: 'read_file',
      content: 'old tool result that should be summarized',
    },
    { role: 'user', content: 'x'.repeat(5000) },
  ];
  const result = truncateMessages(messages, 1000);
  assert.ok(result.some(m => m.content.includes('[Earlier tool memory]')));
  assert.ok(result.some(m => m.content.includes('read_file')));
  assert.ok(result.some(m => m.content.includes('/tmp/a.txt')));
  assert.ok(result.some(m => m.content.includes('old tool result')));
});

test('truncateMessages: rejects an insufficient budget without copying instructions into a user message', () => {
  assert.throws(() => truncateMessages([], 5, 'fallback'), /no room/);
});

test('truncateMessages: counts tool arguments and drops an older oversized group atomically', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'old-large-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ text: 'large argument fixture '.repeat(3000) }) } }] },
    { role: 'tool', name: 'read', tool_call_id: 'old-large-call', content: 'OLD_RESULT_SENTINEL' },
    { role: 'user', content: 'CURRENT_USER_SENTINEL' },
  ];
  const result = truncateMessages(messages, 1500);
  assert.ok(result.some(message => message.content.includes('CURRENT_USER_SENTINEL')));
  assert.ok(!result.some(message => message.tool_calls?.some(call => call.id === 'old-large-call')));
  assert.ok(!result.some(message => message.role === 'tool'));
});

test('truncateMessages: preserves a complete thin tool result whose call is outside client history', () => {
  const result = truncateMessages([{ role: 'tool', name: 'read', tool_call_id: 'thin-call', content: 'Complete result.' }], 100000);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].tool_call_id, 'thin-call');
  assert.strictEqual(result[0].content, 'Complete result.');
});


test('truncateMessages: bounded earlier memory preserves integer argument literals', () => {
  const result = truncateMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'memory-int', type: 'function', function: { name: 'read', arguments: '{ "integer": 9007199254740993 }' } }] },
    { role: 'tool', name: 'read', tool_call_id: 'memory-int', content: 'Completed.' },
    { role: 'user', content: 'Current long question. '.repeat(3000) },
  ], 1000);
  assert.ok(result.some(message => message.content.includes('9007199254740993')));
});
