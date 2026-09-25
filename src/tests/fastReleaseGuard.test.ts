import test from 'node:test';
import assert from 'node:assert';
import { canFastReleaseGuard } from '../utils/degenerate-answer.js';

test('canFastReleaseGuard: releases immediately for code blocks', () => {
  assert.strictEqual(canFastReleaseGuard('```typescript\nfunction hello() {}'), true);
  assert.strictEqual(canFastReleaseGuard('```json\n{"status": "ok"}'), true);
});

test('canFastReleaseGuard: releases immediately for markdown headers and lists', () => {
  assert.strictEqual(canFastReleaseGuard('# Introdução ao Projeto'), true);
  assert.strictEqual(canFastReleaseGuard('## Passo 1: Configuração'), true);
  assert.strictEqual(canFastReleaseGuard('- Primeiro item da lista'), true);
  assert.strictEqual(canFastReleaseGuard('1. Item numerado da lista'), true);
  assert.strictEqual(canFastReleaseGuard('> Citação importante'), true);
});

test('canFastReleaseGuard: releases immediately for JSON or array structures', () => {
  assert.strictEqual(canFastReleaseGuard('{\n  "name": "qwenproxy"\n}'), true);
  assert.strictEqual(canFastReleaseGuard('[\n  {"id": 1}\n]'), true);
});

test('canFastReleaseGuard: releases immediately for multi-line explanations', () => {
  assert.strictEqual(canFastReleaseGuard('Olá!\nAqui está a solução detalhada.'), true);
  assert.strictEqual(canFastReleaseGuard('Entendi o seu problema.\nVamos corrigi-lo agora.'), true);
});

test('canFastReleaseGuard: releases immediately for code keyword statements', () => {
  assert.strictEqual(canFastReleaseGuard('const express = require("express");'), true);
  assert.strictEqual(canFastReleaseGuard('import { useState } from "react";'), true);
  assert.strictEqual(canFastReleaseGuard('export async function main() {'), true);
});

test('canFastReleaseGuard: does NOT release for degenerate acknowledgments', () => {
  assert.strictEqual(canFastReleaseGuard('Yes'), false);
  assert.strictEqual(canFastReleaseGuard('Sim'), false);
  assert.strictEqual(canFastReleaseGuard('OK'), false);
  assert.strictEqual(canFastReleaseGuard('Okay.'), false);
  assert.strictEqual(canFastReleaseGuard('Claro'), false);
  assert.strictEqual(canFastReleaseGuard('Perfeito!'), false);
});
