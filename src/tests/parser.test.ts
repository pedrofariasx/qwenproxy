import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('StreamingToolParser: basic and multiple tool calls', () => {
  const parser = new StreamingToolParser();
  
  // Basic
  const result1 = parser.feed('Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>');
  assert.strictEqual(result1.text, 'Hello! ');
  assert.strictEqual(result1.toolCalls.length, 1);
  assert.strictEqual(result1.toolCalls[0].name, 't1');

  // Multiple in one chunk
  const result2 = parser.feed('<tool_call>{"name": "t2", "arguments": {}}</tool_call><tool_call>{"name": "t3", "arguments": {}}</tool_call>');
  assert.strictEqual(result2.text, '');
  assert.strictEqual(result2.toolCalls.length, 2);
  assert.strictEqual(result2.toolCalls[0].name, 't2');
  assert.strictEqual(result2.toolCalls[1].name, 't3');
});

test('StreamingToolParser: extreme fragmentation', () => {
  const parser = new StreamingToolParser();
  
  assert.strictEqual(parser.feed('Text <tool_').text, 'Text ');
  assert.strictEqual(parser.feed('call>{"name": ').text, '');
  assert.strictEqual(parser.feed('"frag", "arg').text, '');
  const final = parser.feed('uments": {}}</tool_call> trailing');
  
  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, 'frag');
  assert.strictEqual(final.text, ' trailing');
});

test('StreamingToolParser: flush and partial tags', () => {
  const parser = new StreamingToolParser();
  
  // Flush simple text
  parser.feed('Unfinished tag <tool_');
  assert.strictEqual(parser.flush().text, '<tool_');

  // Flush partial tool-like content that CAN be healed
  const parser2 = new StreamingToolParser();
  parser2.feed('Broken tool <tool_call>{"name": "healable"');
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'healable');
  
  // Flush partial tool-like content that CANNOT be healed
  const parser3 = new StreamingToolParser();
  parser3.feed('Invalid <tool_call>NOT_JSON');
  const flushed2 = parser3.flush();
  assert.strictEqual(flushed2.text, '<tool_call>NOT_JSON');
});

test('StreamingToolParser: robust parsing of malformed JSON', () => {
  const parser = new StreamingToolParser();
  
  // Auto-closing braces
  const res = parser.feed('<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test('StreamingToolParser: Qwen-specific delimiters (Bengali)', () => {
  const parser = new StreamingToolParser();
  
  // Full sequence
  const res1 = parser.feed('তত\n{"name":"t1","arguments":{}}✨');
  assert.strictEqual(res1.toolCalls.length, 1);
  assert.strictEqual(res1.toolCalls[0].name, 't1');

  // Fragmented Bengali
  const parser2 = new StreamingToolParser();
  parser2.feed('ত');
  const res2 = parser2.feed('ত\n{"name":"t2","arguments":{}}✨');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 't2');
});

test('StreamingToolParser: preserves tags in non-tool text', () => {
  const parser = new StreamingToolParser();
  
  const res1 = parser.feed('Fake: <tool_call> { "only_args": 1 } </tool_call> ');
  // console.log('DEBUG res1.text:', JSON.stringify(res1.text));
  assert.ok(res1.text.includes('<tool_call>'), 'Should contain start tag');
  assert.ok(res1.text.includes('</tool_call>'), 'Should contain end tag');
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 'r');
});

test('StreamingToolParser: special cases (markdown, flat JSON, noise)', () => {
  const parser = new StreamingToolParser();
  
  // Markdown code block
  const res1 = parser.feed('```xml\n<tool_call>{"name": "m1"}</tool_call>\n```');
  assert.strictEqual(res1.toolCalls[0].name, 'm1');

  // Flat JSON (no arguments field)
  const res2 = parser.feed('<tool_call>{"name": "f1", "p": 1}</tool_call>');
  assert.strictEqual(res2.toolCalls[0].name, 'f1');

  // Noise and empty
  assert.strictEqual(parser.feed('   ').text, '   ');
  assert.strictEqual(parser.feed('').toolCalls.length, 0);
});

test('StreamingToolParser: handles multiple tool calls in array format', () => {
  const parser = new StreamingToolParser();
  
  // Test the exact case from the error
  const chunk = `<tool_call>[
  {"name": "bash", "arguments": {"command": "gh api repos/johngbl/qwenproxy/contents/src/routes?ref=feature/upgrades --jq '.[].name'", "description": "List files in qwenproxy routes dir"}},
  {"name": "bash", "arguments": {"command": "gh api repos/johngbl/qwenproxy/contents/src?ref=feature/upgrades --jq '.[].name'", "description": "List files in qwenproxy src dir"}}
]</tool_call>`;
  
  const result = parser.feed(chunk);
  assert.strictEqual(result.toolCalls.length, 2, 'Should extract both tool calls');
  assert.strictEqual(result.toolCalls[0].name, 'bash');
  assert.strictEqual(result.toolCalls[1].name, 'bash');
  assert.strictEqual(result.toolCalls[0].arguments.command, "gh api repos/johngbl/qwenproxy/contents/src/routes?ref=feature/upgrades --jq '.[].name'");
});
