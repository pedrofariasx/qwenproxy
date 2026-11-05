import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TEST_MOCK_PLAYWRIGHT = 'true'
process.env.API_KEY = ''

const { app } = await import('../../api/server.js')
const { validateUploadMetadata } = await import('../../routes/upload.js')

test('API contract: assigns and preserves request IDs', async () => {
  const response = await app.fetch(new Request('http://localhost/health', {
    headers: { 'X-Request-ID': 'contract-test-1' },
  }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Request-ID'), 'contract-test-1')
})

test('API contract: validates upload metadata and rejects spoofed files', () => {
  const metadata = validateUploadMetadata('photo.png', 10, 'application/octet-stream')
  assert.equal(metadata.fileType, 'image/png')
  assert.equal(metadata.qwenFileType, 'image')

  assert.throws(
    () => validateUploadMetadata('../photo.png', 10, 'image/png'),
    /Invalid filename/,
  )
  assert.throws(
    () => validateUploadMetadata('photo.png', 10, 'application/pdf'),
    /does not match/,
  )
  assert.throws(
    () => validateUploadMetadata('payload.exe', 10, 'application/octet-stream'),
    /Unsupported file type/,
  )
})

test('API contract: supports documented per-user key syntax without a global key', async () => {
  const { parseApiKeyConfig } = await import('../../core/user-manager.js')
  assert.deepEqual(parseApiKeyConfig('contract-user:sk-contract-user,7,2'), [{
    label: 'contract-user',
    key: 'sk-contract-user',
    rateLimitRpm: 7,
    maxConcurrency: 2,
  }])
})

test('API contract: invalid chat requests use OpenAI error envelopes', async () => {
  const missingModel = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  }))
  assert.equal(missingModel.status, 400)
  assert.deepEqual(await missingModel.json(), {
    error: {
      message: 'Missing required parameter: model',
      type: 'invalid_request_error',
      param: 'model',
      code: null,
    },
  })

  const malformed = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  }))
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.type, 'invalid_request_error')
})
