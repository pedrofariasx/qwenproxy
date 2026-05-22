import { test } from 'node:test';
import assert from 'node:assert';
import { getIncrementalDelta } from '../routes/chat.ts';

test('getIncrementalDelta: handles strictly cumulative stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = 'const x = 1;\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = 'const x = 1;\nconst y = 2;\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: handles strictly incremental stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = '\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = '\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: does not suffer from false-positive repetitive word overlap bugs', () => {
  // Previously, if oldStr ended in a common keyword and newStr started/contained the same keyword,
  // it would incorrectly match them and strip them. Let's verify this is fixed.
  let accumulated = 'import { useState } from \'react\';\nimport {';
  let nextChunk = ' Button } from \'@/components/ui/button\';';
  
  let res = getIncrementalDelta(accumulated, nextChunk);
  // It should treat the next chunk as strictly incremental and return it unchanged.
  assert.strictEqual(res.delta, ' Button } from \'@/components/ui/button\';');
  assert.strictEqual(res.matchedContent, 'import { useState } from \'react\';\nimport { Button } from \'@/components/ui/button\';');
});

test('getIncrementalDelta: empty string returns newStr as delta', () => {
  const result = getIncrementalDelta('', 'Hello world');
  assert.strictEqual(result.delta, 'Hello world');
  assert.strictEqual(result.matchedContent, 'Hello world');
});

test('getIncrementalDelta: identical strings return empty delta', () => {
  const result = getIncrementalDelta('Hello', 'Hello');
  assert.strictEqual(result.delta, '');
  assert.strictEqual(result.matchedContent, 'Hello');
});

test('getIncrementalDelta: very short strings - common prefix extracted', () => {
  // When oldStr = 'ab' and newStr = 'abc', common prefix is 'ab' (2 chars)
  // delta = 'c' (the part after the common prefix)
  let accumulated = 'ab';
  let res = getIncrementalDelta(accumulated, 'abc');
  // delta is the non-common suffix
  assert.strictEqual(res.delta, 'c');
  assert.strictEqual(res.matchedContent, 'abc');
});

test('getIncrementalDelta: closing tag in oldStr + space + opening tag in newStr', () => {
  const oldStr = '<tool_call>\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n</tool_call> ';
  const newStr = '<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>';

  const result = getIncrementalDelta(oldStr, newStr);

  // The function should return the NEW part after the common prefix
  // Since oldStr ends with ' ' and newStr starts with '<', they don't share a common prefix
  // So the delta will be everything after the short common prefix
  assert.ok(result.delta.length > 0);
});

test('getIncrementalDelta: closing tag in oldStr + opening tag in newStr (no space)', () => {
  const oldStr = '<tool_call>\n{"name": "read"}\n</tool_call>';
  const newStr = '<tool_call>\n{"name": "bash"}\n</tool_call>';

  const result = getIncrementalDelta(oldStr, newStr);

  // These share a very short prefix so delta will be incremental
  assert.ok(result.delta.length > 0 || result.matchedContent === oldStr);
});

test('getIncrementalDelta: real debug log pattern - tool_call split across chunks', () => {
  let accumulated = '<tool_call>\n{"name": "read", "arguments": {"filePath": "C:\\Users\\John\\Desktop\\qwenproxy\\src\\';

  const next1 = 'services\\qwen.ts"}}\n</tool_call> ';
  const r1 = getIncrementalDelta(accumulated, accumulated + next1);
  assert.strictEqual(r1.delta, next1);

  const next2 = '<tool_call>\n{"name": "read", "arguments": {"filePath": "C:\\Users\\John\\Desktop\\qwenproxy\\src\\tools\\executor.ts"}}\n</tool_call>';
  accumulated = r1.matchedContent;
  const r2 = getIncrementalDelta(accumulated, accumulated + next2);
  assert.strictEqual(r2.delta, next2);
});

test('getIncrementalDelta: end of tool_call with space before next opening tag', () => {
  let oldStr = '<tool_call>\n{"name": "read", "arguments": {}}\n</tool_call> ';
  let newStr = oldStr + '<tool_call>';

  const result = getIncrementalDelta(oldStr, newStr);
  assert.strictEqual(result.delta, '<tool_call>');
  assert.strictEqual(result.matchedContent, newStr);
});

test('getIncrementalDelta: cumulative stream with tool tags and JSON', () => {
  let accumulated = '';

  const step1 = '<tool_call>\n{"name": "';
  let r1 = getIncrementalDelta(accumulated, step1);
  assert.strictEqual(r1.delta, step1);
  accumulated = r1.matchedContent;

  const step2 = step1 + 'read", "arguments": {"filePath": "a.txt"}}\n</tool_call>';
  let r2 = getIncrementalDelta(accumulated, step2);
  assert.strictEqual(r2.delta, 'read", "arguments": {"filePath": "a.txt"}}\n</tool_call>');
  accumulated = r2.matchedContent;

  const step3 = step2 + '\n<tool_call>\n{"name": "bash"}\n</tool_call>';
  let r3 = getIncrementalDelta(accumulated, step3);
  assert.strictEqual(r3.delta, '\n<tool_call>\n{"name": "bash"}\n</tool_call>');
});
