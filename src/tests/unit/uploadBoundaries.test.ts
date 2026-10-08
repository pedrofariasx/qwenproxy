import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OSS from 'ali-oss';
import { Hono } from 'hono';

const originalCwd = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-upload-boundaries-'));
process.chdir(directory);
delete process.env.TEST_MOCK_PLAYWRIGHT;
process.env.LARGE_PROMPT_THRESHOLD = '16';
process.env.LARGE_PROMPT_UPLOAD_CACHE_TTL_MS = '0';
process.env.BACKGROUND_HEADER_REFRESH = 'false';

const { processImagesForQwen, uploadLargePromptAsFile, uploadFile } = await import('../../routes/upload.js');
const { getAccountHeaderCache } = await import('../../services/browser-manager.js');
const { closeDatabase } = await import('../../core/database.js');
const { cache } = await import('../../cache/memory-cache.js');

after(async () => {
  closeDatabase();
  await cache.close();
  process.chdir(originalCwd);
  fs.rmSync(directory, { recursive: true, force: true });
});

const headers = { cookie: 'fixture', 'user-agent': 'fixture', 'bx-ua': 'fixture' };
const stsData = {
  access_key_id: 'fixture', access_key_secret: 'fixture', security_token: 'fixture',
  file_url: 'https://fixture.invalid/upload?signature=fixture', file_path: 'upload',
  file_id: 'fixture-file', bucketname: 'fixture', region: 'oss-cn-hangzhou',
  endpoint: 'oss-cn-hangzhou.aliyuncs.com',
};

test('uploads preserve the exact file bytes at the OSS boundary', async t => {
  let uploaded: Buffer[] = [];
  let declaredSizes: number[] = [];
  let download: Uint8Array | undefined;

  t.mock.method(OSS.prototype, 'put', async (_name: string, bytes: Buffer) => {
    uploaded.push(Buffer.from(bytes));
    return { url: stsData.file_url };
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'https://chat.qwen.ai/api/v2/files/getstsToken') {
      declaredSizes.push(Number(JSON.parse(String(init?.body)).filesize));
      return Response.json({ success: true, data: stsData });
    }
    if (String(input) === 'https://fixture.invalid/input.png' && download) {
      return new Response(Uint8Array.from(download), { headers: { 'Content-Type': 'image/png' } });
    }
    throw new Error('Unexpected network request in upload boundary test');
  });

  function checkBytes(expected: Uint8Array) {
    assert.deepEqual(declaredSizes, [expected.byteLength]);
    assert.equal(uploaded.length, 1, 'OSS.put must be exercised');
    assert.equal(uploaded[0].byteLength, expected.byteLength, 'Only file bytes may be uploaded');
    assert.equal(uploaded[0].equals(expected), true, 'Uploaded bytes must equal the complete input');
  }

  const sizes = [0, 1, 17, Buffer.poolSize / 2 - 1, Buffer.poolSize / 2,
    Buffer.poolSize / 2 + 1, Buffer.poolSize - 1, Buffer.poolSize, 65537];
  const app = new Hono();
  app.post('/v1/upload', uploadFile);
  const headerCache = getAccountHeaderCache('global');
  headerCache.cachedQwenHeaders = { headers, chatSessionId: 'fixture-chat', parentMessageId: null };
  headerCache.lastHeadersTime = Date.now();

  for (const size of sizes) {
    const expected = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 256);
    for (const source of ['base64', 'http', 'multipart'] as const) {
      await t.test(`${source}: ${size} bytes`, async () => {
        uploaded = [];
        declaredSizes = [];
        if (source === 'multipart') {
          const form = new FormData();
          form.set('file', new File([expected], 'fixture.png', { type: 'image/png' }));
          const response = await app.request('/v1/upload', { method: 'POST', body: form });
          assert.equal(response.status, 200);
          assert.equal((await response.json()).url, 'https://fixture.invalid/upload');
        } else {
          download = expected;
          const url = source === 'base64'
            ? `data:image/png;base64,${Buffer.from(expected).toString('base64')}`
            : 'https://fixture.invalid/input.png';
          const result = await processImagesForQwen([{ type: 'image_url', image_url: { url } }], headers);
          assert.equal(result.files.length, 1);
          assert.equal(result.files[0].size, size);
        }
        checkBytes(expected);
      });
    }
  }

  await t.test('base64 preserves a view with synthetic adjacent bytes', async t => {
    uploaded = [];
    declaredSizes = [];
    const marker = Buffer.from('ADJACENT_FIXTURE_BYTES');
    const expected = Buffer.from('tiny fixture file');
    const backing = Buffer.alloc(128, 0x5a);
    backing.set(marker, 0);
    backing.set(expected, 64);
    backing.set(marker, 64 + expected.length);
    const view = backing.subarray(64, 64 + expected.length);
    const encoded = expected.toString('base64');
    const originalFrom = Buffer.from;
    t.mock.method(Buffer, 'from', (...args: any[]) => {
      if (args[0] === encoded && args[1] === 'base64') return view;
      return Reflect.apply(originalFrom, Buffer, args);
    });
    await processImagesForQwen([{ type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } }], headers);
    checkBytes(expected);
    assert.equal(uploaded[0].includes(marker), false);
  });

  for (const prompt of ['tiny fixture file', 'Пример UTF-8 🌍', 'x'.repeat(65537)]) {
    await t.test(`prompt: ${Buffer.byteLength(prompt)} UTF-8 bytes`, async () => {
      uploaded = [];
      declaredSizes = [];
      const result = await uploadLargePromptAsFile(prompt, headers, 'fixture-account');
      assert.ok(result);
      assert.equal(result.size, Buffer.byteLength(prompt));
      checkBytes(Buffer.from(prompt));
    });
  }
});
