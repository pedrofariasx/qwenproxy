import { test } from 'node:test';
import assert from 'node:assert';
import { robustParseJSON } from '../utils/json.js';

test('robustParseJSON: valid JSON passes through directly', () => {
  const result = robustParseJSON('{"name": "test", "arguments": {"a": 1}}');
  assert.deepStrictEqual(result, { name: 'test', arguments: { a: 1 } });
});

test('robustParseJSON: returns null for empty string', () => {
  assert.strictEqual(robustParseJSON(''), null);
});

test('robustParseJSON: returns null for non-object string', () => {
  assert.strictEqual(robustParseJSON('just plain text'), null);
});

test('robustParseJSON: handles markdown code fence wrapping', () => {
  const result = robustParseJSON('```json\n{"name": "test"}\n```');
  assert.deepStrictEqual(result, { name: 'test' });
});

test('robustParseJSON: handles missing closing braces', () => {
  const result = robustParseJSON('{"name": "test", "arguments": {"foo": "bar"');
  assert.ok(result);
  assert.strictEqual(result.arguments.foo, 'bar');
});

test('robustParseJSON: handles missing closing brackets', () => {
  const result = robustParseJSON('{"items": [1, 2, 3');
  assert.ok(result);
  assert.deepStrictEqual(result.items, [1, 2, 3]);
});

test('robustParseJSON: handles double key hallucination', () => {
  const result = robustParseJSON('{"name": "name": "create_file", "arguments": {"path": "b.txt"}}');
  assert.ok(result);
  assert.strictEqual(result.name, 'create_file');
});

test('robustParseJSON: handles unquoted keys', () => {
  const result = robustParseJSON('{"name":"Read",arguments:{"file_path":"test.ts","limit":100}}');
  assert.ok(result);
  assert.strictEqual(result.arguments.limit, 100);
});

test('robustParseJSON: handles control characters in string values', () => {
  const literalNewline = '{"name": "control", "msg": "line 1\nline 2"}';
  const result = robustParseJSON(literalNewline);
  assert.ok(result);
  assert.ok(result.msg.includes('line 1'));
  assert.ok(result.msg.includes('line 2'));
});

test('robustParseJSON: handles Windows path backslashes', () => {
  const result = robustParseJSON('{"path": "C:\\\\Users\\\\name\\\\Documents"}');
  assert.ok(result);
  assert.ok(
    result.path === 'C:\\Users\\name\\Documents' || result.path === 'C:\\\\Users\\\\name\\\\Documents',
    `Unexpected path: ${result.path}`
  );
});

test('robustParseJSON: handles trailing comma', () => {
  const result = robustParseJSON('{"name": "test", "value": 42,}');
  assert.ok(result);
  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.value, 42);
});

test('robustParseJSON: handles complex nested suggest payload', () => {
  const payload = '{"name": "suggest", "arguments": {"suggest": "Landing page criada", "actions": [{"label": "Revisar", "description": "Review", "prompt": "/local-review-uncommitted"}]})';
  const result = robustParseJSON(payload);
  assert.ok(result);
  assert.strictEqual(result.name, 'suggest');
  assert.ok(result.arguments.actions.length >= 1);
});

test('robustParseJSON: handles deeply nested malformed JSON gracefully', () => {
  const crazy = `{"name": "suggest", "arguments": {"suggest": "ok", "actions": [{"label": "test"<tool_call>\n{"name": "broken"}]}}`;
  const result = robustParseJSON(crazy);
  assert.ok(result === null || typeof result === 'object');
});

test('robustParseJSON: strips leading text before first brace', () => {
  const result = robustParseJSON('some text before {"name": "found"}');
  assert.ok(result);
  assert.strictEqual(result.name, 'found');
});

test('robustParseJSON: handles array values correctly', () => {
  const result = robustParseJSON('{"items": ["a", "b", "c"]}');
  assert.ok(result);
  assert.deepStrictEqual(result.items, ['a', 'b', 'c']);
});

test('robustParseJSON: handles numeric values', () => {
  const result = robustParseJSON('{"count": 42, "ratio": 3.14}');
  assert.ok(result);
  assert.strictEqual(result.count, 42);
  assert.strictEqual(result.ratio, 3.14);
});

test('robustParseJSON: handles boolean and null values', () => {
  const result = robustParseJSON('{"active": true, "deleted": false, "data": null}');
  assert.ok(result);
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.deleted, false);
  assert.strictEqual(result.data, null);
});

test('robustParseJSON: handles unquoted string value after colon', () => {
  const result = robustParseJSON('{"name": "bash", "arguments": {"command":export CI=true GIT_PAGER=cat npm run build, "description": "Build"}}');
  assert.ok(result);
  assert.strictEqual(result.name, 'bash');
  assert.ok(typeof result.arguments.command === 'string');
  assert.ok(result.arguments.command.includes('export CI=true'));
  assert.strictEqual(result.arguments.description, 'Build');
});

test('robustParseJSON: handles unquoted string value with special chars', () => {
  const result = robustParseJSON('{"name": "bash", "arguments": {"command":git add -A && git commit -m "fix"}}');
  assert.ok(result);
  assert.strictEqual(result.name, 'bash');
  assert.ok(typeof result.arguments.command === 'string');
  assert.ok(result.arguments.command.includes('git add'));
});

test('robustParseJSON: handles missing opening quote on string value', () => {
  const result = robustParseJSON('{"name":read", "arguments": {"filePath": "/tmp/test.ts"}}');
  assert.ok(result);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.arguments.filePath, '/tmp/test.ts');
});

test('robustParseJSON: handles missing opening quote on multiple values', () => {
  const result = robustParseJSON('{"name":bash", "command":ls -la", "description": "List files"}');
  assert.ok(result);
  assert.strictEqual(result.name, 'bash');
  assert.strictEqual(result.command, 'ls -la');
  assert.strictEqual(result.description, 'List files');
});

test('robustParseJSON: handles missing opening quote with unquoted key', () => {
  const result = robustParseJSON('{name:read", "arguments": {"filePath": "/tmp/test.ts"}}');
  assert.ok(result);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.arguments.filePath, '/tmp/test.ts');
});
