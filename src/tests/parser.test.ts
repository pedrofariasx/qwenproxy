import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';
import { robustParseJSON } from '../utils/json.ts';

test('StreamingToolParser: basic tool call', () => {
  const parser = new StreamingToolParser();
  const chunk1 = 'Hello! <tool_call>{"name": "test_tool", "arguments": {"foo": "bar"}}</tool_call>';
  const result = parser.feed(chunk1);
  
  assert.strictEqual(result.text, 'Hello! ');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'test_tool');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { foo: 'bar' });
});

test('StreamingToolParser: fragmented tool call', () => {
  const parser = new StreamingToolParser();
  
  const res1 = parser.feed('Some text <tool_');
  assert.strictEqual(res1.text, 'Some text ');
  assert.strictEqual(res1.toolCalls.length, 0);
  
  const res2 = parser.feed('call>{"name": "fragmented", "arg');
  assert.strictEqual(res2.text, '');
  assert.strictEqual(res2.toolCalls.length, 0);
  
  const res3 = parser.feed('uments": {"ok": true}}</tool_call> Trailing text');
  assert.strictEqual(res3.text, ''); // Text after tools is only emitted if no tools were emitted yet, or we need to handle it differently
  assert.strictEqual(res3.toolCalls.length, 1);
  assert.strictEqual(res3.toolCalls[0].name, 'fragmented');
  assert.deepStrictEqual(res3.toolCalls[0].arguments, { ok: true });
});

test('StreamingToolParser: multiple tool calls', () => {
  const parser = new StreamingToolParser();
  const chunk = '<tool_call>{"name": "t1", "arguments": {}}</tool_call><tool_call>{"name": "t2", "arguments": {}}</tool_call>';
  const result = parser.feed(chunk);
  
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 't1');
  assert.strictEqual(result.toolCalls[1].name, 't2');
});

test('StreamingToolParser: flush partial content', () => {
  const parser = new StreamingToolParser();
  // We feed something that could be a partial tag start to keep it in buffer
  const res1 = parser.feed('Unfinished text <tool_');
  assert.strictEqual(res1.text, 'Unfinished text ');
  
  const res2 = parser.flush();
  assert.strictEqual(res2.text, '<tool_');
  assert.strictEqual(res2.toolCalls.length, 0);
});

test('StreamingToolParser: robust parsing in stream', () => {
  const parser = new StreamingToolParser();
  // Missing closing brace but end tag present
  const result = parser.feed('<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>');
  
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 1 });
});

test('robustParseJSON: repairs multiline JSON payload', () => {
  const parsed = robustParseJSON(String.raw`
    {
      name: 'edit',
      arguments: {
        filePath: '/tmp/demo.md',
        oldString: 'linha 1\nlinha 2',
        newString: 'linha A\nlinha B',
      },
    }
  `);

  assert.deepStrictEqual(parsed, {
    name: 'edit',
    arguments: {
      filePath: '/tmp/demo.md',
      oldString: 'linha 1\nlinha 2',
      newString: 'linha A\nlinha B',
    },
  });
});

test('StreamingToolParser: invalid tool call falls back to text', () => {
  const parser = new StreamingToolParser();
  const rawToolCall = '<tool_call>{"name": null, "arguments": 123}</tool_call>';
  const result = parser.feed(rawToolCall);

  assert.strictEqual(result.toolCalls.length, 0);
  assert.strictEqual(result.text, rawToolCall);
  assert.deepStrictEqual(result.invalidToolCalls, [
    {
      raw: '{"name": null, "arguments": 123}',
      reason: 'invalid_payload',
    },
  ]);
});

test('StreamingToolParser: can suppress invalid tool fallback text', () => {
  const parser = new StreamingToolParser({ fallbackInvalidToolCallsToText: false });
  const result = parser.feed('<tool_call>{"name": null, "arguments": 123}</tool_call>');

  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 0);
  assert.deepStrictEqual(result.invalidToolCalls, [
    {
      raw: '{"name": null, "arguments": 123}',
      reason: 'invalid_payload',
    },
  ]);
});

test('StreamingToolParser: flush reports invalid tool call metadata', () => {
  const parser = new StreamingToolParser({ fallbackInvalidToolCallsToText: false });
  parser.feed('<tool_call>{"name": "edit", "arguments": "unterminated');

  const result = parser.flush();

  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 0);
  assert.deepStrictEqual(result.invalidToolCalls, [
    {
      raw: '{"name": "edit", "arguments": "unterminated',
      reason: 'invalid_payload',
    },
  ]);
});

test('StreamingToolParser: keeps leading text and tracks invalid tool between valid ones', () => {
  const parser = new StreamingToolParser();
  const result = parser.feed(
    'Intro <tool_call>{"name": "first", "arguments": {"ok": true}}</tool_call>' +
    '<tool_call>{"name": null, "arguments": 123}</tool_call>' +
    '<tool_call>{"name": "second", "arguments": {"count": 2}}</tool_call>'
  );

  assert.strictEqual(result.text, 'Intro <tool_call>{"name": null, "arguments": 123}</tool_call>');
  assert.strictEqual(result.toolCalls.length, 2);
  assert.deepStrictEqual(result.toolCalls.map((toolCall) => toolCall.name), ['first', 'second']);
  assert.deepStrictEqual(result.invalidToolCalls, [
    {
      raw: '{"name": null, "arguments": 123}',
      reason: 'invalid_payload',
    },
  ]);
});

test('StreamingToolParser: preserves trailing text after invalid tool when no valid tools were emitted', () => {
  const parser = new StreamingToolParser();
  const result = parser.feed('Prefix <tool_call>{"name": null, "arguments": 123}</tool_call> Suffix');

  assert.strictEqual(result.toolCalls.length, 0);
  assert.strictEqual(result.text, 'Prefix <tool_call>{"name": null, "arguments": 123}</tool_call> Suffix');
  assert.deepStrictEqual(result.invalidToolCalls, [
    {
      raw: '{"name": null, "arguments": 123}',
      reason: 'invalid_payload',
    },
  ]);
});
