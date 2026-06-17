import { test } from 'node:test';
import assert from 'node:assert';
import { getIncrementalDelta } from '../routes/chat.js';

test('getIncrementalDelta: handles strictly cumulative stream correctly', () => {
  let accumulated = '';
  
  const chunk1 = 'const x = 1;';
  const res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  const chunk2 = 'const x = 1;\nconst y = 2;';
  const res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  const chunk3 = 'const x = 1;\nconst y = 2;\nconst z = 3;';
  const res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: handles strictly incremental stream correctly', () => {
  let accumulated = '';
  
  const chunk1 = 'const x = 1;';
  const res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  const chunk2 = '\nconst y = 2;';
  const res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  const chunk3 = '\nconst z = 3;';
  const res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: does not suffer from false-positive repetitive word overlap bugs', () => {
  const accumulated = 'import { useState } from \'react\';\nimport {';
  const nextChunk = ' Button } from \'@/components/ui/button\';';
  
  const res = getIncrementalDelta(accumulated, nextChunk);
  assert.strictEqual(res.delta, ' Button } from \'@/components/ui/button\';');
  assert.strictEqual(res.matchedContent, 'import { useState } from \'react\';\nimport { Button } from \'@/components/ui/button\';');
});

test('getIncrementalDelta: empty oldStr returns newStr as delta', () => {
  const res = getIncrementalDelta('', 'hello world');
  assert.strictEqual(res.delta, 'hello world');
  assert.strictEqual(res.matchedContent, 'hello world');
  assert.strictEqual(res.contentLength, 11);
});

test('getIncrementalDelta: identical strings return empty delta', () => {
  const str = 'some content here';
  const res = getIncrementalDelta(str, str, str.length, str.slice(-64));
  assert.strictEqual(res.delta, '');
  assert.strictEqual(res.matchedContent, str);
});

test('getIncrementalDelta: completely different strings concatenate', () => {
  const res = getIncrementalDelta('abc', 'xyz');
  assert.strictEqual(res.delta, 'xyz');
  assert.strictEqual(res.matchedContent, 'abcxyz');
});

test('getIncrementalDelta: uses prevLength fast path when suffix matches', () => {
  const oldStr = 'hello world';
  const prevLength = oldStr.length;
  const prevSuffix = oldStr.slice(-64);
  const newStr = 'hello world extended';
  
  const res = getIncrementalDelta(oldStr, newStr, prevLength, prevSuffix);
  assert.strictEqual(res.delta, ' extended');
  assert.strictEqual(res.matchedContent, newStr);
  assert.strictEqual(res.contentLength, newStr.length);
});

test('getIncrementalDelta: large string with tiny delta falls back to concatenation for safety', () => {
  const oldStr = 'x'.repeat(3000);
  const tinyDelta = 'a';
  const newStr = oldStr + tinyDelta;
  
  const res = getIncrementalDelta(oldStr, newStr, oldStr.length, oldStr.slice(-64));
  assert.strictEqual(res.matchedContent, newStr);
});

test('getIncrementalDelta: contentSuffix tracks last 64 characters', () => {
  const longStr = 'a'.repeat(100);
  const res = getIncrementalDelta('', longStr);
  assert.strictEqual(res.contentSuffix.length, 64);
  assert.strictEqual(res.contentSuffix, 'a'.repeat(64));
});

test('getIncrementalDelta: handles segment-based prefix matching', () => {
  const prefix = 'a'.repeat(200);
  const oldStr = prefix + 'OLD';
  const newStr = prefix + 'NEW';
  
  const res = getIncrementalDelta(oldStr, newStr);
  assert.ok(res.delta.length > 0);
});

test('getIncrementalDelta: works through a realistic multi-chunk stream', () => {
  let accumulated = '';
  const chunks = [
    'The',
    'The quick',
    'The quick brown',
    'The quick brown fox',
    'The quick brown fox jumps',
    'The quick brown fox jumps over the lazy dog.',
  ];
  
  let finalDelta = '';
  for (const chunk of chunks) {
    const res = getIncrementalDelta(accumulated, chunk, accumulated.length, accumulated.slice(-64));
    finalDelta += res.delta;
    accumulated = res.matchedContent;
  }
  
  assert.strictEqual(accumulated, 'The quick brown fox jumps over the lazy dog.');
  assert.strictEqual(finalDelta, 'The quick brown fox jumps over the lazy dog.');
});
