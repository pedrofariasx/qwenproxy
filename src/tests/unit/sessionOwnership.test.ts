import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../helpers/ownership-scenario.ts', import.meta.url));
for (const scenario of ['global', 'env-only', 'db-only', 'db-only-required', 'env-only-required', 'mixed', 'required-without-keys', 'anonymous', 'same-client-key', 'aliases-and-tools', 'foreign-stop', 'legacy-migration', 'key-rotation', 'env-key-rotation', 'namespace-collisions', 'persistence', 'storage-guard', 'migration-conflict', 'env-whitespace']) {
  test(`HTTP auth and session ownership: ${scenario}`, { timeout: 20000 }, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, scenario], { encoding: 'utf8', timeout: 18000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
