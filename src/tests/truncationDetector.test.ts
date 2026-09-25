import test from 'node:test';
import assert from 'node:assert';
import { isTruncatedResponse } from '../utils/truncation-detector.js';

test('isTruncatedResponse: returns true when finishReason is length', () => {
  assert.strictEqual(isTruncatedResponse('This is a complete sentence.', 'length'), true);
});

test('isTruncatedResponse: returns true when markdown code fence is unclosed', () => {
  const truncatedCode = 'Here is the implementation:\n```typescript\nfunction hello() {\n  console.log("hello");\n';
  assert.strictEqual(isTruncatedResponse(truncatedCode), true);

  const completedCode = 'Here is the implementation:\n```typescript\nfunction hello() {\n  console.log("hello");\n}\n```';
  assert.strictEqual(isTruncatedResponse(completedCode), false);
});

test('isTruncatedResponse: returns true when ending with incomplete operator or syntax', () => {
  assert.strictEqual(isTruncatedResponse('const result = a + b + '), true);
  assert.strictEqual(isTruncatedResponse('const config = { foo: "bar", '), true);
  assert.strictEqual(isTruncatedResponse('function runTask(items: string[], '), true);
});

test('isTruncatedResponse: returns true when ending with incomplete keyword', () => {
  assert.strictEqual(isTruncatedResponse('We can implement this by writing:\nexport async function '), true);
  assert.strictEqual(isTruncatedResponse('Inside the function, we declare:\nconst '), true);
});

test('isTruncatedResponse: returns false for complete normal answers', () => {
  assert.strictEqual(isTruncatedResponse('Aqui está a resposta completa explicada em detalhes.'), false);
  assert.strictEqual(isTruncatedResponse('Sim, posso ajudar com isso.'), false);
  assert.strictEqual(isTruncatedResponse('```json\n{"status": "ok"}\n```'), false);
});

test('isTruncatedResponse: handles short or empty text safely', () => {
  assert.strictEqual(isTruncatedResponse(''), false);
  assert.strictEqual(isTruncatedResponse('ok'), false);
  assert.strictEqual(isTruncatedResponse('   '), false);
});
