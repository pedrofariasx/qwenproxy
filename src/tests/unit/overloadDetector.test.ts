import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverloadMessage } from '../../utils/overload-detector.js';

test('isOverloadMessage: detects English overload phrases', () => {
  assert.strictEqual(isOverloadMessage('We are experiencing high demand right now.'), true);
  assert.strictEqual(isOverloadMessage('There is a problem connecting to the service.'), true);
  assert.strictEqual(isOverloadMessage('Please try again later.'), true);
  assert.strictEqual(isOverloadMessage('The server is busy, please try again.'), true);
  assert.strictEqual(isOverloadMessage('Service is temporarily unavailable.'), true);
  assert.strictEqual(isOverloadMessage('Too many requests, please wait.'), true);
});

test('isOverloadMessage: detects Portuguese overload phrases', () => {
  assert.strictEqual(isOverloadMessage('Estamos com alta demanda no momento.'), true);
  assert.strictEqual(isOverloadMessage('Houve um problema de conexão.'), true);
  assert.strictEqual(isOverloadMessage('Tente novamente mais tarde.'), true);
  assert.strictEqual(isOverloadMessage('Servidor ocupado, aguarde.'), true);
});

test('isOverloadMessage: does not flag normal responses', () => {
  assert.strictEqual(isOverloadMessage('Here is the solution to your problem.'), false);
  assert.strictEqual(isOverloadMessage('The code connects to the database using a connection pool.'), false);
  assert.strictEqual(isOverloadMessage('I can help you with that request.'), false);
  assert.strictEqual(isOverloadMessage(''), false);
  assert.strictEqual(isOverloadMessage(null), false);
  assert.strictEqual(isOverloadMessage(undefined), false);
});

test('isOverloadMessage: rejects very long content', () => {
  const longText = 'high demand '.repeat(100);
  assert.strictEqual(isOverloadMessage(longText), false);
});
