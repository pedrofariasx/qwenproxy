import { test } from 'node:test';
import assert from 'node:assert';
import { executeToolCalls } from '../tools/executor.ts';
import { registry } from '../tools/registry.ts';
import type { ToolContext } from '../utils/types.ts';

test('executeToolCalls: parallel execution', async () => {
  let activeCount = 0;
  let maxParallel = 0;

  registry.register(
    'parallel_tool',
    'A tool that waits to test parallelism',
    { type: 'object', properties: {} },
    async () => {
      activeCount++;
      maxParallel = Math.max(maxParallel, activeCount);
      await new Promise(r => setTimeout(r, 100));
      activeCount--;
      return 'done';
    }
  );

  const toolCalls = [
    { id: '1', name: 'parallel_tool', arguments: {} },
    { id: '2', name: 'parallel_tool', arguments: {} },
    { id: '3', name: 'parallel_tool', arguments: {} },
  ];

  const context: ToolContext = {
    messages: [],
    turn: 0,
    model: 'test'
  };

  const results = await executeToolCalls(toolCalls, context);

  assert.strictEqual(results.length, 3);
  assert.ok(maxParallel > 1, `Max parallel should be > 1, got ${maxParallel}`);

  registry.unregister('parallel_tool');
});

test('executeToolCalls: error handling for unknown tool', async () => {
  const toolCalls = [
    { id: '1', name: 'nonexistent_tool', arguments: {} },
  ];

  const context: ToolContext = {
    messages: [],
    turn: 0,
    model: 'test'
  };

  const results = await executeToolCalls(toolCalls, context);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].isError, true);
  assert.ok(results[0].result.includes('Unknown tool'), 'Error result should mention unknown tool');
});

test('executeToolCalls: context is passed correctly', async () => {
  let receivedContext: ToolContext | null = null;

  registry.register(
    'context_tool',
    'A tool that captures context',
    { type: 'object', properties: {} },
    async (args, context) => {
      receivedContext = context;
      return 'done';
    }
  );

  const toolCalls = [
    { id: '1', name: 'context_tool', arguments: {} },
  ];

  const context: ToolContext = {
    messages: [{ role: 'user', content: 'test message' }],
    turn: 5,
    model: 'qwen3.6-plus'
  };

  await executeToolCalls(toolCalls, context);

  assert.ok(receivedContext, 'Context should be passed to tool handler');
  const ctx = receivedContext as ToolContext;
  assert.strictEqual(ctx.turn, 5, 'Turn should be passed correctly');
  assert.strictEqual(ctx.model, 'qwen3.6-plus', 'Model should be passed correctly');

  registry.unregister('context_tool');
});

test('executeToolCalls: result serialization works', async () => {
  registry.register(
    'return_tool',
    'A tool that returns various types',
    { type: 'object', properties: {} },
    async () => {
      return { status: 'success', data: [1, 2, 3] };
    }
  );

  const toolCalls = [
    { id: '1', name: 'return_tool', arguments: {} },
  ];

  const context: ToolContext = {
    messages: [],
    turn: 0,
    model: 'test'
  };

  const results = await executeToolCalls(toolCalls, context);

  assert.strictEqual(results[0].isError, false);
  const result = JSON.parse(results[0].result);
  assert.deepStrictEqual(result, { status: 'success', data: [1, 2, 3] });

  registry.unregister('return_tool');
});
