import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingToolParser } from '../tools/parser.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';

const tools: FunctionToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Start a helper agent',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
];

test('parses adjacent raw JSON tool calls without leaking them as text', () => {
  const parser = new StreamingToolParser(tools);
  const result = parser.feed(
    '<tool_call>{"name":"spawn_agent","arguments":{"label":"one"}}</tool_call>{"name":"spawn_agent","arguments":{"label":"two"}}'
  );
  const flush = parser.flush();

  assert.equal(result.text + flush.text, '');
  assert.equal(result.toolCalls.length + flush.toolCalls.length, 2);
  assert.deepEqual(
    [...result.toolCalls, ...flush.toolCalls].map((call) => call.arguments.label),
    ['one', 'two']
  );
});

test('drops malformed tool markup when tools are active', () => {
  const parser = new StreamingToolParser(tools);
  const first = parser.feed('working\n<tool_call>{"name":"spawn_agent","arguments":');
  const flush = parser.flush();
  const visible = first.text + flush.text;

  assert.equal(visible, '');
  assert.equal(first.toolCalls.length + flush.toolCalls.length, 0);
  assert.equal(visible.includes('<tool_call>'), false);
});

test('drops incomplete raw tool JSON when tools are active', () => {
  const parser = new StreamingToolParser(tools);
  const first = parser.feed('working\n{"name":"spawn_agent","arguments":');
  const flush = parser.flush();

  assert.equal(first.text + flush.text, '');
  assert.equal(first.toolCalls.length + flush.toolCalls.length, 0);
});

test('recovers markdown-punctuated tool names when the client tool name matches', () => {
  const parser = new StreamingToolParser(tools);
  const result = parser.feed(
    '<tool_call>{"name":"*spawn_agent","arguments":{"label":"utils"}}</tool_call>'
  );

  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'spawn_agent');
  assert.equal(result.toolCalls[0].arguments.label, 'utils');
});
