import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';
import { getIncrementalDelta } from '../routes/chat.ts';

test('StreamingToolParser: opening tag split across chunks (real bug pattern)', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool');
  assert.strictEqual(r1.toolCalls.length, 0);
  assert.strictEqual(r1.text, '');

  const r2 = parser.feed('_call>');
  assert.strictEqual(r2.toolCalls.length, 0);
  assert.strictEqual(r2.text, '');

  const r3 = parser.feed('\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n</tool_call>');
  assert.strictEqual(r3.toolCalls.length, 1);
  assert.strictEqual(r3.toolCalls[0].name, 'read');
  assert.strictEqual(r3.toolCalls[0].arguments.filePath, 'a.txt');
  assert.strictEqual(r3.text, '');
});

test('StreamingToolParser: closing tag split across chunks (real bug pattern)', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n</tool');
  assert.strictEqual(r1.toolCalls.length, 0);
  assert.strictEqual(r1.text, '');

  const r2 = parser.feed('_call>');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].name, 'read');
  assert.strictEqual(r2.text, '');
});

test('StreamingToolParser: closing and opening split across chunks with space', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n</tool_call> ');
  assert.strictEqual(r1.toolCalls.length, 1);
  assert.strictEqual(r1.toolCalls[0].name, 'read');

  const r2 = parser.feed('<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].name, 'bash');
});

test('StreamingToolParser: multiple tool calls in sequence with fragmented tags', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n</tool_call>\n<tool_call>\n{"name": "');
  assert.strictEqual(r1.toolCalls.length, 1);
  assert.strictEqual(r1.toolCalls[0].name, 'read');

  const r2 = parser.feed('bash", "arguments": {"command": "ls"}}\n</tool_call>');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].name, 'bash');
});

test('StreamingToolParser: end tag fragment with newline before closing', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {}}\n</tool');
  assert.strictEqual(r1.toolCalls.length, 0);

  const r2 = parser.feed('_call>\n');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].name, 'read');
});

test('StreamingToolParser: partial end tag does not flush incomplete content', () => {
  const parser = new StreamingToolParser();

  parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "');
  const r = parser.feed('C:\\Users');
  assert.strictEqual(r.toolCalls.length, 0);
  assert.strictEqual(r.text, '');

  const r2 = parser.feed('\\John\\a.txt"}}\n</tool_call>');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].arguments.filePath, 'C:\\Users\\John\\a.txt');
});

test('StreamingToolParser: getPartialEndTagLength helper works', () => {
  const parser = new StreamingToolParser() as any;

  parser.buffer = '</tool';
  assert.strictEqual(parser.getPartialEndTagLength(), 6);

  parser.buffer = '</tool_call';
  assert.strictEqual(parser.getPartialEndTagLength(), 11);

  parser.buffer = '</tool_call>';
  assert.strictEqual(parser.getPartialEndTagLength(), 12);

  parser.buffer = 'some text </tool';
  assert.strictEqual(parser.getPartialEndTagLength(), 6);

  parser.buffer = 'no closing tag here';
  assert.strictEqual(parser.getPartialEndTagLength(), 0);
});

test('StreamingToolParser: real debug log pattern - tool_call fragment with newline', () => {
  const parser = new StreamingToolParser();

  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "C:\\\\Users\\\\John\\\\Desktop\\\\qwenproxy\\\\src\\\\services\\\\qwen.ts"}}\n</tool_call>\n');
  assert.strictEqual(r1.toolCalls.length, 1);
  assert.strictEqual(r1.toolCalls[0].name, 'read');

  const r2 = parser.feed('<tool_call>');
  // Opening tag of second tool
  assert.strictEqual(r2.toolCalls.length, 0);

  const r3 = parser.feed('\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>');
  // Second tool fully arrives
  assert.strictEqual(r3.toolCalls.length, 1);
  assert.strictEqual(r3.toolCalls[0].name, 'bash');
});

test('StreamingToolParser: real debug pattern from mpgehg0p - </tool split across chunks', () => {
  const parser = new StreamingToolParser();

  // Simula chunks 26-33 do debug_raw_mpgehg0p.txt
  // O </tool_call> está fragmentado: chunk 32 termina em '</' e chunk 33 é 'tool_call>\n'
  parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "src/tools/executor.ts"}}\n');
  const r1 = parser.feed('</');
  // Ainda aguardando o fechamento
  assert.strictEqual(r1.toolCalls.length, 0);

  const r2 = parser.feed('tool_call>\n');
  // Agora o fechamento está completo, tool call extraída
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].name, 'read');

  const r3 = parser.feed('<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>');
  // Próxima tool call também deve ser extraída
  assert.strictEqual(r3.toolCalls.length, 1);
  assert.strictEqual(r3.toolCalls[0].name, 'bash');
});

test('StreamingToolParser: exact real sequence from debug_raw_mpgd48ig.txt', () => {
  const parser = new StreamingToolParser();

  parser.feed('<tool_call>');
  const r2 = parser.feed('\n{"name":');
  assert.strictEqual(r2.toolCalls.length, 0);

  const r3 = parser.feed(' "read", "');
  assert.strictEqual(r3.toolCalls.length, 0);

  const r4 = parser.feed('arguments": {"filePath');
  assert.strictEqual(r4.toolCalls.length, 0);

  const r5 = parser.feed('": "C:\\\\');
  assert.strictEqual(r5.toolCalls.length, 0);

  const r6 = parser.feed('Users\\\\John\\\\');
  assert.strictEqual(r6.toolCalls.length, 0);

  const r7 = parser.feed('Desktop\\\\qwen');
  assert.strictEqual(r7.toolCalls.length, 0);

  const r8 = parser.feed('proxy\\\\src\\\\');
  assert.strictEqual(r8.toolCalls.length, 0);

  const r9 = parser.feed('services\\\\qwen');
  assert.strictEqual(r9.toolCalls.length, 0);

  const r10 = parser.feed('.ts"}}\n');
  // Buffer now: </tool_call>\n<tool_call>\n{"name": "read", "arguments": ...}\n
  assert.strictEqual(r10.toolCalls.length, 0);

  const r11 = parser.feed('</tool');
  assert.strictEqual(r11.toolCalls.length, 0);

  // When </tool_call>\n arrives, parser finds </tool_call> in buffer and extracts the tool
  const r12 = parser.feed('_call>\n');
  assert.strictEqual(r12.toolCalls.length, 1);
  assert.strictEqual(r12.toolCalls[0].name, 'read');

  const r13 = parser.feed('<tool_call>');
  assert.strictEqual(r13.toolCalls.length, 0);

  const r14 = parser.feed('\n{"name":');
  assert.strictEqual(r14.toolCalls.length, 0);

  const r15 = parser.feed(' "read", "');
  assert.strictEqual(r15.toolCalls.length, 0);

  const r16 = parser.feed('arguments": {"filePath": "C:\\\\Users\\\\John\\\\Desktop\\\\qwenproxy\\\\src\\\\tools\\\\executor.ts"}}\n</tool_call>');
  assert.strictEqual(r16.toolCalls.length, 1);
  assert.strictEqual(r16.toolCalls[0].name, 'read');
});

test('StreamingToolParser: flush recovers incomplete tool call at end', () => {
  const parser = new StreamingToolParser();

  parser.feed('<tool_call>');
  parser.feed('\n{"name": "read", "arguments": {"filePath": "a.txt"}}\n');

  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read');
});

test('StreamingToolParser: very long content between end tag fragments does not get stuck', () => {
  const parser = new StreamingToolParser();

  const longContent = 'a'.repeat(300);
  const r1 = parser.feed('<tool_call>\n{"name": "read", "arguments": {"filePath": "' + longContent + '"}}\n</tool');
  assert.strictEqual(r1.toolCalls.length, 0);

  const r2 = parser.feed('_call>');
  assert.strictEqual(r2.toolCalls.length, 1);
  assert.strictEqual(r2.toolCalls[0].arguments.filePath, longContent);
});

// ===== INTEGRATION TEST: Full flow from debug_raw_mph0f2qn.txt =====

test('INTEGRATION: exact flow from debug_raw_mph0f2qn - bash then glob', () => {
  // Simulate the EXACT chunks from the raw Qwen SSE stream
  const qwenChunks = [
    '<tool_call',           // line 4
    '>\n{"name',            // line 5
    '\": \"bash\",',        // line 6
    ' \"arguments\": {\"',  // line 7
    'command\": \"ls',      // line 8
    ' -la\", \"',           // line 9
    'description\": \"List',// line 10
    ' all files in project',// line 11
    ' root\"}}\n</',         // line 12
    'tool_call>\n',         // line 13
    '<tool_call>',          // line 14
    '\n{"name":',           // line 15
    ' \"glob\", \"',        // line 16
    'arguments\": {\"pattern',// line 17
    '\": \"**/*\"}}',       // line 18
    '\n</tool_call',        // line 19
    '>',                     // line 20
  ];

  let lastFullContent = '';
  const parser = new StreamingToolParser();
  const allToolCalls: any[] = [];
  let allText = '';

  let step = 0;
  for (const chunk of qwenChunks) {
    const result = getIncrementalDelta(lastFullContent, chunk);
    console.log(`Step ${step}: oldStrLen=${lastFullContent.length} chunk="${chunk}" delta="${result.delta}" matchedLen=${result.matchedContent.length} insideTool=${parser.isInsideTool()} buffer="${(parser as any).buffer}"`);
    if (result.delta) {
      const { text, toolCalls } = parser.feed(result.delta);
      console.log(`  after feed: text="${text}" tools=${toolCalls.length} insideTool=${parser.isInsideTool()} buffer="${(parser as any).buffer}"`);
      allText += text;
      allToolCalls.push(...toolCalls);
    }
    lastFullContent = result.matchedContent;
    step++;
  }

  // Flush any remaining content
  const flushed = parser.flush();
  allText += flushed.text;
  allToolCalls.push(...flushed.toolCalls);

  // Should have extracted BOTH tool calls
  assert.strictEqual(allToolCalls.length, 2, `Expected 2 tool calls but got ${allToolCalls.length}. Text was: "${allText}"`);
  assert.strictEqual(allToolCalls[0].name, 'bash');
  assert.strictEqual(allToolCalls[0].arguments.command, 'ls -la');
  assert.strictEqual(allToolCalls[1].name, 'glob');
  assert.strictEqual(allToolCalls[1].arguments.pattern, '**/*');
});