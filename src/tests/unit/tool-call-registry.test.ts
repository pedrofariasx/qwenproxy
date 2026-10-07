import { describe, it } from 'node:test';
import assert from 'node:assert';
import { recordToolCallEmission, lookupToolCall } from '../../core/tool-call-registry.js';

describe('tool-call-registry', () => {
  it('records and resolves a tool call by chat id', () => {
    recordToolCallEmission('chat-1', 'call_abc', 'read_file', '{"path":"/tmp/x"}');
    const rec = lookupToolCall('chat-1', 'call_abc');
    assert.ok(rec);
    assert.strictEqual(rec!.name, 'read_file');
    assert.strictEqual(rec!.args, '{"path":"/tmp/x"}');
  });

  it('returns undefined for unknown chat/call ids', () => {
    assert.strictEqual(lookupToolCall('chat-1', 'call_missing'), undefined);
    assert.strictEqual(lookupToolCall('chat-unknown', 'call_abc'), undefined);
  });

  it('does not leak across different chats', () => {
    recordToolCallEmission('chat-a', 'call_x', 'bash', '{}');
    assert.strictEqual(lookupToolCall('chat-b', 'call_x'), undefined);
  });

  it('ignores empty ids', () => {
    recordToolCallEmission('', 'call_y', 'x', '{}');
    recordToolCallEmission('chat-c', '', 'x', '{}');
    assert.strictEqual(lookupToolCall('chat-c', ''), undefined);
  });
});
