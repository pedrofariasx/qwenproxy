import test from 'node:test'
import assert from 'node:assert/strict'
import {
  noteAccessToken,
  invalidateAccessToken,
  isAuthorizationUsable,
  getAuthorizationHeader,
  registerHeaderStoreAccessor,
  resetAuthSessions
} from '../../services/auth-session.js'

test('auth-session: notes and verifies usable token', () => {
  resetAuthSessions()
  const fakeStore = { currentHeaders: {} as Record<string, string>, lastHeadersTime: 0 }
  registerHeaderStoreAccessor(() => fakeStore)

  const futureExp = Math.floor(Date.now() / 1000) + 900 // 15 mins
  const payloadBase64 = Buffer.from(JSON.stringify({ exp: futureExp })).toString('base64')
  const testToken = `header.${payloadBase64}.signature`

  noteAccessToken('acct-1', testToken, 'test')
  assert.strictEqual(isAuthorizationUsable('acct-1'), true)
  assert.strictEqual(getAuthorizationHeader('acct-1'), `Bearer ${testToken}`)
  assert.strictEqual(fakeStore.currentHeaders['authorization'], `Bearer ${testToken}`)
})

test('auth-session: handles invalidation with backoff state', () => {
  resetAuthSessions()
  const fakeStore = { currentHeaders: { authorization: 'Bearer old' }, lastHeadersTime: 0 }
  registerHeaderStoreAccessor(() => fakeStore)

  invalidateAccessToken('acct-1', 'test-invalidation')
  assert.strictEqual(isAuthorizationUsable('acct-1'), false)
  assert.strictEqual(getAuthorizationHeader('acct-1'), null)
  assert.strictEqual(fakeStore.currentHeaders['authorization'], undefined)
})
