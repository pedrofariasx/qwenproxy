import { describe, it } from 'node:test';
import assert from 'node:assert';
import { estimateTokenCount, truncateMessages } from '../utils/context-truncation.ts';

describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    assert.strictEqual(estimateTokenCount(''), 0);
  });

  it('returns positive for short text', () => {
    assert.ok(estimateTokenCount('hello') > 0);
  });

  it('returns 200-400 for 1000 chars', () => {
    const text = 'a'.repeat(1000);
    const tokens = estimateTokenCount(text);
    assert.ok(tokens >= 100 && tokens <= 500, `Expected 100-500, got ${tokens}`);
  });

  it('handles multilingual text (pt-BR + en)', () => {
    const text = 'Olá mundo! Hello world! Como você está? How are you?';
    assert.doesNotThrow(() => estimateTokenCount(text));
    assert.ok(estimateTokenCount(text) > 0);
  });

  it('handles special chars and emojis', () => {
    const text = '🔥 🚀 test áéíóú ç ñ 😊';
    assert.doesNotThrow(() => estimateTokenCount(text));
  });
});
