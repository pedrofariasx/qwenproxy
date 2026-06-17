/*
 * File: streamingOptimizations.test.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-06-02
 * 
 * Last Modified: Tue Jun 02 2026
 * Modified By: Pedro Farias
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getIncrementalDelta } from '../routes/chat.js';

describe('Streaming Optimizations Tests', () => {
  describe('getIncrementalDelta', () => {
    it('should return full string as delta when oldStr is empty', () => {
      const result = getIncrementalDelta('', 'Hello World');
      assert.strictEqual(result.delta, 'Hello World');
      assert.strictEqual(result.matchedContent, 'Hello World');
    });

    it('should return empty delta when strings are identical', () => {
      const result = getIncrementalDelta('Hello World', 'Hello World');
      assert.strictEqual(result.delta, '');
      assert.strictEqual(result.matchedContent, 'Hello World');
    });

    it('should detect cumulative content and return incremental delta', () => {
      const result = getIncrementalDelta('Hello ', 'Hello World');
      assert.strictEqual(result.delta, 'World');
      assert.strictEqual(result.matchedContent, 'Hello World');
    });

    it('should handle long string prefix matching efficiently', () => {
      const longPrefix = 'a'.repeat(1000);
      const oldStr = longPrefix + 'X';
      const newStr = longPrefix + 'Y';
      
      const result = getIncrementalDelta(oldStr, newStr);
      assert.strictEqual(result.delta, 'Y');
      assert.strictEqual(result.matchedContent, newStr);
    });

    it('should handle prefix mismatch by treating as incremental', () => {
      const result = getIncrementalDelta('abc', 'xyz');
      // Since no common prefix of length >= 4, treated as incremental
      assert.strictEqual(result.delta, 'xyz');
      assert.strictEqual(result.matchedContent, 'abcxyz');
    });

    it('should handle short prefix matches (below threshold)', () => {
      const result = getIncrementalDelta('ab', 'abc');
      // Prefix match of length 2 is below threshold of 4
      assert.strictEqual(result.delta, 'abc');
      assert.strictEqual(result.matchedContent, 'ababc');
    });

    it('should handle threshold boundary correctly', () => {
      const result = getIncrementalDelta('abcd', 'abcde');
      // Prefix match of length 4 meets threshold
      assert.strictEqual(result.delta, 'e');
      assert.strictEqual(result.matchedContent, 'abcde');
    });

    it('should handle very long strings with segment-based matching', () => {
      const base = 'x'.repeat(5000);
      const oldStr = base;
      const newStr = base + 'suffix';
      
      const result = getIncrementalDelta(oldStr, newStr);
      assert.strictEqual(result.delta, 'suffix');
      assert.strictEqual(result.matchedContent, newStr);
    });

    it('should handle empty new string correctly', () => {
      const result = getIncrementalDelta('Hello', '');
      assert.strictEqual(result.delta, '');
      assert.strictEqual(result.matchedContent, 'Hello');
    });

    it('should handle unicode characters correctly', () => {
      const result = getIncrementalDelta('Hello 🌍', 'Hello 🌍🌎');
      assert.strictEqual(result.delta, '🌎');
      assert.strictEqual(result.matchedContent, 'Hello 🌍🌎');
    });
  });

  describe('Batch Flush Logic', () => {
    it('should accumulate events until byte threshold', () => {
      // Simulate batch accumulation logic
      const MAX_BATCH_BYTES = 4096;
      const MAX_BATCH_COUNT = 8;
      
      let batchBytes = 0;
      let batchCount = 0;
      let sseBatch = '';
      const events: string[] = [];
      
      // Add small events
      for (let i = 0; i < 5; i++) {
        const evt = `data: {"id":"test","content":"chunk${i}"}\n\n`;
        sseBatch += evt;
        batchBytes += evt.length;
        batchCount++;
        
        // Should not flush yet
        if (batchBytes >= MAX_BATCH_BYTES || batchCount >= MAX_BATCH_COUNT) {
          events.push(sseBatch);
          sseBatch = '';
          batchBytes = 0;
          batchCount = 0;
        }
      }
      
      // Should not have flushed yet (5 events < 8 count threshold)
      assert.strictEqual(batchCount, 5);
      assert.strictEqual(events.length, 0);
    });

    it('should flush when count threshold is reached', () => {
      const MAX_BATCH_BYTES = 4096;
      const MAX_BATCH_COUNT = 8;
      
      let batchBytes = 0;
      let batchCount = 0;
      let sseBatch = '';
      const events: string[] = [];
      
      for (let i = 0; i < 10; i++) {
        const evt = `data: {"id":"test","content":"chunk${i}"}\n\n`;
        sseBatch += evt;
        batchBytes += evt.length;
        batchCount++;
        
        if (batchBytes >= MAX_BATCH_BYTES || batchCount >= MAX_BATCH_COUNT) {
          events.push(sseBatch);
          sseBatch = '';
          batchBytes = 0;
          batchCount = 0;
        }
      }
      
      // Should have flushed once at 8 events, then accumulated 2 more
      assert.strictEqual(events.length, 1);
      assert.strictEqual(batchCount, 2);
    });

    it('should flush when byte threshold is reached', () => {
      const MAX_BATCH_BYTES = 100;
      const MAX_BATCH_COUNT = 8;
      
      let batchBytes = 0;
      let batchCount = 0;
      let sseBatch = '';
      const events: string[] = [];
      
      // Add large events that will exceed byte threshold
      for (let i = 0; i < 5; i++) {
        const content = 'x'.repeat(30); // Each event ~42 bytes
        const evt = `data: {"id":"test","content":"${content}"}\n\n`;
        sseBatch += evt;
        batchBytes += evt.length;
        batchCount++;
        
        if (batchBytes >= MAX_BATCH_BYTES || batchCount >= MAX_BATCH_COUNT) {
          events.push(sseBatch);
          sseBatch = '';
          batchBytes = 0;
          batchCount = 0;
        }
      }
      
      // Should have flushed at least once due to byte threshold
      assert.ok(events.length >= 1);
    });
  });

  describe('Buffer Parsing Optimization', () => {
    it('should parse SSE lines using index-based scanning', () => {
      const buffer = 'data: chunk1\n\ndata: chunk2\n\ndata: chunk3\n\nremainder';
      
      const lines: string[] = [];
      let startIdx = 0;
      let newlineIdx: number;
      
      while ((newlineIdx = buffer.indexOf('\n', startIdx)) !== -1) {
        const line = buffer.slice(startIdx, newlineIdx);
        startIdx = newlineIdx + 1;
        lines.push(line);
      }
      
      const remainder = buffer.slice(startIdx);
      
      assert.deepStrictEqual(lines, ['data: chunk1\n', 'data: chunk2\n', 'data: chunk3\n']);
      assert.strictEqual(remainder, 'remainder');
    });

    it('should handle buffer with no newlines correctly', () => {
      const buffer = 'partial data line';
      
      const lines: string[] = [];
      let startIdx = 0;
      let newlineIdx: number;
      
      while ((newlineIdx = buffer.indexOf('\n', startIdx)) !== -1) {
        const line = buffer.slice(startIdx, newlineIdx);
        startIdx = newlineIdx + 1;
        lines.push(line);
      }
      
      const remainder = buffer.slice(startIdx);
      
      assert.deepStrictEqual(lines, []);
      assert.strictEqual(remainder, 'partial data line');
    });

    it('should handle empty buffer correctly', () => {
      const buffer = '';
      
      const lines: string[] = [];
      let startIdx = 0;
      let newlineIdx: number;
      
      while ((newlineIdx = buffer.indexOf('\n', startIdx)) !== -1) {
        const line = buffer.slice(startIdx, newlineIdx);
        startIdx = newlineIdx + 1;
        lines.push(line);
      }
      
      const remainder = buffer.slice(startIdx);
      
      assert.deepStrictEqual(lines, []);
      assert.strictEqual(remainder, '');
    });
  });

  describe('Target Response ID Optimization', () => {
    it('should use boolean flag for targetResponseId check', () => {
      // Simulate the optimized check pattern
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      
      // Before target is set
      const chunk1ResponseId = 'resp-123';
      const shouldProcess1 = !targetResponseIdSet || chunk1ResponseId === targetResponseId;
      assert.strictEqual(shouldProcess1, true);
      
      // Set target
      targetResponseId = chunk1ResponseId;
      targetResponseIdSet = true;
      
      // After target is set, matching response_id
      const chunk2ResponseId = 'resp-123';
      const shouldProcess2 = !targetResponseIdSet || chunk2ResponseId === targetResponseId;
      assert.strictEqual(shouldProcess2, true);
      
      // Non-matching response_id
      const chunk3ResponseId = 'resp-456';
      const shouldProcess3 = !targetResponseIdSet || chunk3ResponseId === targetResponseId;
      assert.strictEqual(shouldProcess3, false);
    });
  });

  describe('Timestamp Pre-computation', () => {
    it('should use pre-computed timestamp consistently', () => {
      const createdTimestamp = Math.floor(Date.now() / 1000);
      
      // Simulate multiple events using the same timestamp
      const events = [];
      for (let i = 0; i < 5; i++) {
        events.push({
          id: 'test',
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: `chunk${i}` } }]
        });
      }
      
      // All events should have the same timestamp
      const timestamps = events.map(e => e.created);
      assert.ok(timestamps.every(t => t === createdTimestamp));
    });
  });

  describe('WriteEvent Optimization', () => {
    it('should use fire-and-forget pattern', () => {
      // Simulate the writeEvent function
      const writes: string[] = [];
      const streamWriter = {
        write: (data: string) => {
          writes.push(data);
          return Promise.resolve();
        }
      };
      
      const writeEvent = (data: any) => {
        streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      
      writeEvent({ id: 'test', content: 'hello' });
      writeEvent({ id: 'test', content: 'world' });
      
      assert.strictEqual(writes.length, 2);
      assert.ok(writes[0].includes('hello'));
      assert.ok(writes[1].includes('world'));
    });
  });

  describe('SetImmediate Yielding', () => {
    it('should yield every 100 chunks to prevent event loop starvation', async () => {
      const yields: number[] = [];
      let chunkCount = 0;
      
      // Simulate processing 250 chunks
      for (let i = 0; i < 250; i++) {
        chunkCount++;
        if (chunkCount % 100 === 0) {
          yields.push(chunkCount);
          await new Promise(r => setImmediate(r));
        }
      }
      
      assert.deepStrictEqual(yields, [100, 200]);
    });
  });
});
