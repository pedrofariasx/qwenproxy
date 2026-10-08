import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.HYBRID_SESSION_VERIFY = 'false';
delete process.env.API_KEY;
delete process.env.AUTH_REQUIRED;
const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cache-usage-'));
process.chdir(directory);
const { app } = await import('../../api/server.js');
const { addAccount } = await import('../../core/accounts.js');
const { closeDatabase } = await import('../../core/database.js');
const { getSessionParent } = await import('../../services/session-manager.js');
addAccount('usage-fixture@example.test', 'fixture-password');

after(() => {
  closeDatabase();
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
});

for (const streaming of [false, true]) {
  test(`Qwen cached input tokens are preserved in ${streaming ? 'SSE' : 'JSON'} responses`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response([
      'data: {"response.created":{"response_id":"cache-parent"}}\n\n',
      'data: {"response_id":"cache-parent","choices":[{"delta":{"content":"A complete cached answer.","phase":"answer"}}],"usage":{"input_tokens":12000,"output_tokens":9,"prompt_tokens_details":{"cached_tokens":11000}}}\n\n',
      'data: {"response.created":{"response_id":"secondary-parent"}}\n\n',
      'data: {"response_id":"secondary-parent","choices":[{"delta":{"content":"Unselected alternate answer.","phase":"answer"}}],"usage":{"input_tokens":15000,"output_tokens":30,"prompt_tokens_details":{"cached_tokens":14000}}}\n\n',
      'data: [DONE]\n\n',
    ].join(''));
    try {
      const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.7-plus', messages: [{ role: 'user', content: 'Explain the fixture.' }], stream: streaming, stream_options: { include_usage: true } }),
      }));
      assert.equal(response.status, 200);
      const text = await response.text();
      const chunks = streaming
        ? text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
        : [JSON.parse(text)];
      const result = chunks.find(chunk => chunk.usage);
      assert.equal(result.usage.prompt_tokens, 12000);
      assert.equal(result.usage.prompt_tokens_details.cached_tokens, 11000);
      const sessionId = chunks.find(chunk => chunk.session_id)?.session_id;
      assert.ok(sessionId);
      assert.equal(getSessionParent(sessionId), 'cache-parent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
