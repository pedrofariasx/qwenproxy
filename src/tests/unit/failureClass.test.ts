import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, failureAction } from '../../services/failure-class.js'

test('classifyFailure identifies standard auth errors', () => {
  assert.strictEqual(classifyFailure({ code: 'Unauthorized' }), 'auth')
  assert.strictEqual(classifyFailure({ code: 'TokenExpired' }), 'auth')
  assert.strictEqual(classifyFailure({ status: 401 }), 'auth')
  assert.strictEqual(classifyFailure({ message: 'Qwen upstream error: unauthorized: Token has expired, please log in again.' }), 'auth')
})

test('classifyFailure identifies anti-bot challenges', () => {
  assert.strictEqual(classifyFailure({ code: 'FAIL_SYS_USER_VALIDATE' }), 'anti-bot')
  assert.strictEqual(classifyFailure({ message: '_____tmd_____/punish?something' }), 'anti-bot')
  assert.strictEqual(classifyFailure({ status: 403 }), 'anti-bot')
})

test('classifyFailure identifies quota & rate limits', () => {
  assert.strictEqual(classifyFailure({ code: 'RateLimited' }), 'quota')
  assert.strictEqual(classifyFailure({ status: 429 }), 'quota')
  assert.strictEqual(classifyFailure({ message: 'Wait about 2 hour(s) before trying again.' }), 'quota')
})

test('classifyFailure identifies transient errors', () => {
  assert.strictEqual(classifyFailure({ message: 'The chat is in progress' }), 'transient')
  assert.strictEqual(classifyFailure({ message: 'Warm pool empty after retry' }), 'transient')
})

test('failureAction determines proper recovery policies', () => {
  const authAct = failureAction({ code: 'Unauthorized' })
  assert.strictEqual(authAct.category, 'auth')
  assert.strictEqual(authAct.canRetry, true)
  assert.strictEqual(authAct.triggerTokenRenewal, true)
  assert.strictEqual(authAct.tripCircuit, false)
  assert.strictEqual(authAct.quarantineAccount, false)
  assert.strictEqual(authAct.clientStatus, 401)

  const antibotAct = failureAction({ code: 'FAIL_SYS_USER_VALIDATE' })
  assert.strictEqual(antibotAct.category, 'anti-bot')
  assert.strictEqual(antibotAct.canRetry, false)
  assert.strictEqual(antibotAct.tripCircuit, true)
  assert.strictEqual(antibotAct.quarantineAccount, true)
  assert.strictEqual(antibotAct.clientStatus, 403)
})
