import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { serve } from '@hono/node-server';
import { app } from '../api/server.js';
import { initPlaywright, closePlaywright } from '../services/playwright.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mediaDir = path.join(__dirname, 'media');

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function getFreePort(startPort: number): Promise<number> {
  let port = startPort;
  while (true) {
    const available = await isPortAvailable(port);
    if (available) return port;
    port++;
  }
}

function fileToDataUri(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp4: 'video/mp4', mp3: 'audio/mpeg',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return `data:${mimeMap[ext] || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

async function sendMultimodalRequest(
  port: number,
  prompt: string,
  urlType: string,
  dataUri: string,
): Promise<{ content: string; reasoning: string }> {
  const contentPart: any = { type: urlType };
  if (urlType === 'image_url') contentPart.image_url = { url: dataUri };
  else if (urlType === 'video_url') contentPart.video_url = { url: dataUri };
  else if (urlType === 'audio_url') contentPart.audio_url = { url: dataUri };
  else contentPart.file_url = { url: dataUri };

  const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        contentPart,
      ]}],
      stream: true
    })
  });

  assert.strictEqual(response.status, 200, `Expected 200, got ${response.status}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoning = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(dataStr);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      } catch { /* ignore */ }
    }
  }

  return { content, reasoning };
}

test('Multimodal: all media files with real Qwen responses', { skip: process.env.CI ? 'Requires real accounts - skipped in CI' : false }, async () => {
  const port = await getFreePort(3200);
  const server = serve({ fetch: app.fetch, port });
  console.log(`[MultimodalTest] Server started on port ${port}`);

  await initPlaywright(true);

  try {
    const scenarios = [
      { file: 'farias.png', urlType: 'image_url', prompt: 'Descreva essa imagem em detalhes', requireContent: true },
      { file: 'video.mp4', urlType: 'video_url', prompt: 'Descreva o conteúdo deste vídeo', requireContent: true },
      { file: 'audio.mp3', urlType: 'audio_url', prompt: 'Transcreva e descreva o que é dito neste áudio', requireContent: true },
      { file: 'doc1.pdf', urlType: 'file_url', prompt: 'Resuma o conteúdo deste documento PDF', requireContent: false },
      { file: 'doc2.xlsx', urlType: 'file_url', prompt: 'Analise os dados desta planilha e descreva o que contém', requireContent: false },
    ];

    for (const scenario of scenarios) {
      const filePath = path.join(mediaDir, scenario.file);
      if (!fs.existsSync(filePath)) {
        console.log(`[MultimodalTest] SKIP ${scenario.file} - not found`);
        continue;
      }

      const dataUri = fileToDataUri(filePath);
      console.log(`[MultimodalTest] Sending ${scenario.file} (${(fs.statSync(filePath).size / 1024).toFixed(1)}KB)...`);

      const { content, reasoning } = await sendMultimodalRequest(port, scenario.prompt, scenario.urlType, dataUri);

      console.log(`[MultimodalTest] ${scenario.file} => ${content.length} chars`);
      if (content) console.log(`  Content: ${content.substring(0, 300)}`);
      if (reasoning) console.log(`  Reasoning: ${reasoning.substring(0, 150)}...`);

      if (scenario.requireContent) {
        assert.ok(content.length > 10, `${scenario.file}: expected meaningful response, got ${content.length} chars`);
      } else if (content.length === 0) {
        console.log(`[MultimodalTest] WARN: ${scenario.file} returned empty response (Qwen may not support this file type via ${scenario.urlType})`);
      }
    }
  } finally {
    await closePlaywright();
    server.close();
    console.log('[MultimodalTest] Done.');
  }
});
