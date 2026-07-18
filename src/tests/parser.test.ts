import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.js';

const TC_OPEN = '<tool_' + 'call>';
const TC_CLOSE = '</tool_' + 'call>';

test('StreamingToolParser: basic tool call', () => {
  const parser = new StreamingToolParser();
  const result = parser.feed(`Hello! ${TC_OPEN}{"name": "t1", "arguments": {"a": 1}}${TC_CLOSE}`);
  assert.strictEqual(result.text, 'Hello! ');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 't1');
});

test('StreamingToolParser: multiple tool calls', () => {
  const parser = new StreamingToolParser();
  const result = parser.feed(`${TC_OPEN}{"name": "t2", "arguments": {}}${TC_CLOSE}${TC_OPEN}{"name": "t3", "arguments": {}}${TC_CLOSE}`);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 't2');
  assert.strictEqual(result.toolCalls[1].name, 't3');
});

test('StreamingToolParser: fragmented tool call', () => {
  const parser = new StreamingToolParser();
  assert.strictEqual(parser.feed('Text <tool_').text, 'Text ');
  assert.strictEqual(parser.feed('call>{"name": ').text, '');
  const final = parser.feed(`"frag", "arguments": {}}${TC_CLOSE} trailing`);
  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, 'frag');
  assert.strictEqual(final.text, ' trailing');
});

test('StreamingToolParser: flush partial content', () => {
  const parser = new StreamingToolParser();
  parser.feed('Unfinished tag <tool_');
  assert.strictEqual(parser.flush().text, '<tool_');

  const parser2 = new StreamingToolParser();
  parser2.feed(`${TC_OPEN}{"name": "healable"`);
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'healable');

  const parser3 = new StreamingToolParser();
  parser3.feed(`Invalid ${TC_OPEN}NOT_JSON`);
  const flushed2 = parser3.flush();
  assert.strictEqual(flushed2.text, `${TC_OPEN}NOT_JSON${TC_CLOSE}`);
});

test('StreamingToolParser: robust parsing of malformed JSON', () => {
  const parser = new StreamingToolParser();
  const res = parser.feed(`${TC_OPEN}{"name": "broken", "arguments": {"a": 1}${TC_CLOSE}`);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test('StreamingToolParser: preserves tags in non-tool text', () => {
  const parser = new StreamingToolParser();
  const res1 = parser.feed(`Fake: ${TC_OPEN} { "only_args": 1 } ${TC_CLOSE} `);
  assert.ok(res1.text.includes(TC_OPEN), 'Should contain start tag');
  assert.ok(res1.text.includes(TC_CLOSE), 'Should contain close tag');
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed(`Real: ${TC_OPEN}{"name":"r"}${TC_CLOSE}`);
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 'r');
});

test('StreamingToolParser: handles multiple tool calls in array format', () => {
  const parser = new StreamingToolParser();
  const chunk = `${TC_OPEN}[
  {"name": "bash", "arguments": {"command": "ls", "description": "List files"}},
  {"name": "read", "arguments": {"path": "test.txt"}}
]${TC_CLOSE}`;
  const result = parser.feed(chunk);
  assert.strictEqual(result.toolCalls.length, 2, 'Should extract both tool calls');
  assert.strictEqual(result.toolCalls[0].name, 'bash');
  assert.strictEqual(result.toolCalls[1].name, 'read');
  assert.strictEqual(result.toolCalls[0].arguments.command, 'ls');
});

test('StreamingToolParser: double-escaped quotes in JSON', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{\\"name\\": \\"edit\\", \\"arguments\\": {\\"filePath\\": \\"/tmp/test.txt\\", \\"content\\": \\"hello\\"}}${TC_CLOSE}`;
  const res = parser.feed(input);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.strictEqual(res.toolCalls[0].arguments.filePath, '/tmp/test.txt');
});

test('StreamingToolParser: double-escaped quotes in XML parameters', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}\n<name>write</name>\n<parameter name=\\"content\\">&lt;div&gt;hello &amp; world&lt;/div&gt;</parameter>\n${TC_CLOSE}`;
  const res = parser.feed(input);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'write');
  assert.strictEqual(res.toolCalls[0].arguments.content, '<div>hello & world</div>');
});

test('StreamingToolParser: truncated JSON with unclosed string', () => {
  const parser = new StreamingToolParser();
  const res = parser.feed(`${TC_OPEN}{"name": "bash", "arguments": {"command": "echo hello${TC_CLOSE}`);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'bash');
  assert.strictEqual(typeof res.toolCalls[0].arguments.command, 'string');
});

test('StreamingToolParser: flush double-escaped tool call', () => {
  const parser = new StreamingToolParser();
  parser.feed(`${TC_OPEN}{\\"name\\": \\"recover\\",\\"arguments\\": {\\"a\\": \\"val`);
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'recover');
});

test('StreamingToolParser: handles literal close tag inside JSON string', () => {
  const parser = new StreamingToolParser();
  const toolCallJson = JSON.stringify({
    name: "edit",
    arguments: {
      filePath: "/tmp/test.ts",
      oldString: `some code with ${TC_CLOSE} inside a string value`,
      newString: "replacement code"
    }
  });
  const fullInput = `${TC_OPEN}${toolCallJson}${TC_CLOSE}`;
  const res = parser.feed(fullInput);
  assert.strictEqual(res.toolCalls.length, 1, 'Should parse the tool call despite to literal close tag in string');
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.strictEqual(res.toolCalls[0].arguments.filePath, '/tmp/test.ts');
  assert.ok(
    (res.toolCalls[0].arguments.oldString as string).includes(TC_CLOSE),
    'oldString should contain the literal close tag'
  );
});

test('StreamingToolParser: unquoted arguments key with nested string values containing colons', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"todowrite",arguments:{"todos":[{"content":"Add versions/activeVersionIndex to DB schema with migration","status":"completed","priority":"high"},{"content":"Update dbService to handle versions","status":"completed","priority":"high"},{"content":"Update ChatStore types and add regenerateMessage + switchVersion methods","status":"in_progress","priority":"high"},{"content":"Update Chat.tsx handleRegenerate to use new regenerateMessage","status":"pending"}]}}${TC_CLOSE}`;
  const res = parser.feed(input);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'todowrite');
  assert.strictEqual((res.toolCalls[0].arguments.todos as any[]).length, 4);
  assert.strictEqual((res.toolCalls[0].arguments.todos as any[])[2].status, 'in_progress');
});

test('StreamingToolParser: handles literal close tag in streamed chunks', () => {
  const parser = new StreamingToolParser();
  const toolCallJson = JSON.stringify({
    name: "edit",
    arguments: {
      filePath: "/tmp/app.ts",
      oldString: `function foo() { return "${TC_CLOSE}"; }`,
      newString: "function bar() {}"
    }
  });
  const fullInput = `${TC_OPEN}${toolCallJson}${TC_CLOSE}`;
  const mid = Math.floor(fullInput.length / 2);
  const chunk1 = fullInput.substring(0, mid);
  const chunk2 = fullInput.substring(mid);

  parser.feed(chunk1);
  const res = parser.feed(chunk2);
  assert.strictEqual(res.toolCalls.length, 1, 'Should parse across chunk boundaries');
  assert.strictEqual(res.toolCalls[0].name, 'edit');
});

test('StreamingToolParser: parses consecutive JSON objects in one block', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"one","arguments":{"a":1}}
{"name":"two","arguments":{"b":2}}${TC_CLOSE}`;
  const res = parser.feed(input);
  assert.strictEqual(res.toolCalls.length, 2);
  assert.strictEqual(res.toolCalls[0].name, 'one');
  assert.strictEqual(res.toolCalls[1].name, 'two');
});

test('StreamingToolParser: parses OpenAI-style tool_calls wrapper', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":\\"abc\\"}"}}]}${TC_CLOSE}`;
  const res = parser.feed(input);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].id, 'call_a');
  assert.strictEqual(res.toolCalls[0].name, 'lookup');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { query: 'abc' });
});

test('StreamingToolParser: handles truncated close tag before environment details', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"edit","arguments":{"path":"a.txt","content":"hello"}}</tool<environment_details>
Current time: 2026-06-22T21:37:19-03:00
Working directory: /tmp/project
</environment_details>`;
  const res = parser.feed(input);

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.txt', content: 'hello' });
  assert.strictEqual(res.text, '');
});

test('StreamingToolParser: handles bare truncated close before environment details', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"edit","arguments":{"path":"a.txt","content":"hello"}}</<environment_details>
Current time: 2026-06-22T21:41:36-03:00
Working directory: /tmp/project
</environment_details>`;
  const res = parser.feed(input);

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.txt', content: 'hello' });
  assert.strictEqual(res.text, '');
});

test('StreamingToolParser: handles truncated close followed by plain text and environment details', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"edit","arguments":{"path":"a.txt","content":"hello"}}</tool

Ele manda como se fosse uma resposta de texto do modelo<environment_details>
Current time: 2026-06-22T21:47:17-03:00
Working directory: /home/pedro/Documentos/YouTube/qwenproxy
Workspace root folder: /home/pedro/Documentos/YouTube/qwenproxy
</environment_details>`;
  const res = parser.feed(input);

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.txt', content: 'hello' });
  assert.ok(!res.text.includes('</tool'));
});

test('StreamingToolParser: handles short close tag', () => {
  const parser = new StreamingToolParser();
  const res = parser.feed(`${TC_OPEN}{"name":"write","arguments":{"path":"a.txt"}}</tool>`);

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'write');
});

test('StreamingToolParser: does not leak </environment_details> after proper close tag', () => {
  const parser = new StreamingToolParser();
  const input = `${TC_OPEN}{"name":"edit","arguments":{"path":"a.txt","content":"hello"}}${TC_CLOSE}\n\n</environment_details>\nCurrent time: 2026-07-18T15:26:30-03:00\nWorking directory: /tmp/project\n</environment_details>`;
  const res = parser.feed(input);
  const flushed = parser.flush();
  const text = res.text + flushed.text;

  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'edit');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.txt', content: 'hello' });
  assert.ok(!text.includes('environment_details'), `text should not leak environment_details, got: ${JSON.stringify(text)}`);
  assert.strictEqual(text, '');
});

test('StreamingToolParser: does not leak environment_details when streamed char-by-char', () => {
  const parser = new StreamingToolParser();
  const full = `${TC_OPEN}{"name":"edit","arguments":{"path":"a.txt","content":"hi"}}${TC_CLOSE}\n</environment_details>\nCurrent time: x\n</environment_details>`;
  let text = '';
  let toolCalls = 0;
  for (const ch of full) {
    const r = parser.feed(ch);
    text += r.text;
    toolCalls += r.toolCalls.length;
  }
  const f = parser.flush();
  text += f.text;
  toolCalls += f.toolCalls.length;

  assert.strictEqual(toolCalls, 1);
  assert.ok(!text.includes('environment_details'), `text should not leak environment_details, got: ${JSON.stringify(text)}`);
});
