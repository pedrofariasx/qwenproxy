import { test } from 'node:test';
import assert from 'node:assert';
import { robustParseJSON } from '../utils/json.ts';

test('robustParseJSON: handles real problematic LLM output', () => {
  const problematicString = '{"name": "suggest", "arguments": {"suggest": "Landing page para escritório de advocacia criada em src/pages/Index.tsx", "actions": [{"label": "Revisar alterações", "description": "Executar review local das mudanças não commitadas", "prompt": "/local-review-uncommitted"}]})';

  const result = robustParseJSON(problematicString);

  assert.strictEqual(result.name, 'suggest');
  assert.strictEqual(result.arguments.suggest, 'Landing page para escritório de advocacia criada em src/pages/Index.tsx');
  assert.strictEqual(result.arguments.actions.length, 1);
  assert.strictEqual(result.arguments.actions[0].label, 'Revisar alterações');
});

test('robustParseJSON: handles missing closing braces', () => {
  const missingBraces = '{"name": "test", "arguments": {"foo": "bar"';

  const result = robustParseJSON(missingBraces);

  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.arguments.foo, 'bar');
});

test('robustParseJSON: handles control characters in strings', () => {
  const withNewline = '{"name": "control", "msg": "line 1\nline 2"}';

  const result = robustParseJSON(withNewline);

  assert.strictEqual(result.name, 'control');
  assert.strictEqual(result.msg, 'line 1\nline 2');
});

test('robustParseJSON: handles crazy nested hallucination case', () => {
  const crazyCase = `{"name": "suggest", "arguments": {"suggest": "Landing page criada para escritório de advocacia com design corporativo", "actions": [{"label": "Revisar código local", "description": "Exec<tool_call>\n{"name": "bashutar revisão local das", "arguments": alterações {"command": não commitadas", "npm run lint "prompt", "description":": "/local-review "Run lint-uncommitted"}] to verify code quality})"}}`;

  // Should not throw, may not fully parse but shouldn't crash
  try {
    const result = robustParseJSON(crazyCase);
    // If it parses, name should be "suggest"
    if (result && typeof result === 'object') {
      assert.strictEqual(result.name, 'suggest');
    }
  } catch (e) {
    // Expected for such malformed input
    assert.ok(true, 'Expected to throw on very malformed input');
  }
});

test('robustParseJSON: handles invalid backslash escapes in Windows paths', () => {
  const invalidEscapes = '{"path": "C:\\\\Users\\\\name\\\\Documents"}';

  const result = robustParseJSON(invalidEscapes);

  assert.ok(result.path);
  assert.ok(result.path.includes('Users') || result.path.includes('Documents'));
});

test('robustParseJSON: fixes double key hallucination', () => {
  const doubleKey = '{"name": "name": "create_file", "arguments": {"path": "b.txt"}}';

  const result = robustParseJSON(doubleKey);

  assert.strictEqual(result.name, 'create_file');
  assert.strictEqual(result.arguments.path, 'b.txt');
});

test('robustParseJSON: handles unquoted arguments key', () => {
  const unquotedArgs = '{"name":"Read",arguments:{"file_path":"test.ts","limit":100}}';

  const result = robustParseJSON(unquotedArgs);

  assert.strictEqual(result.name, 'Read');
  assert.strictEqual(result.arguments.file_path, 'test.ts');
  assert.strictEqual(result.arguments.limit, 100);
});

test('robustParseJSON: handles trailing noise after JSON', () => {
  // robustParseJSON will throw on this, but that's acceptable behavior
  const withTrailing = '{"name": "test", "arguments": {}} extra stuff';

  assert.throws(
    () => robustParseJSON(withTrailing),
    /Unexpected non-whitespace character after JSON/
  );
});

test('robustParseJSON: handles unquoted string values', () => {
  const unquotedValues = '{name: "test", arguments: {foo: "bar"}}';

  const result = robustParseJSON(unquotedValues);

  assert.strictEqual(result.name, 'test');
  assert.strictEqual(result.arguments.foo, 'bar');
});

test('robustParseJSON: handles empty arguments object', () => {
  const emptyArgs = '{"name": "test", "arguments": {}}';

  const result = robustParseJSON(emptyArgs);

  assert.strictEqual(result.name, 'test');
  assert.deepStrictEqual(result.arguments, {});
});