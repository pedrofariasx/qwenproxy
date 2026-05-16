/*
 * File: index.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { fetchQwenModels } from './services/qwen.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, activePage } from './services/playwright.ts';

dotenv.config();

export const app = new Hono();

app.use('*', cors());

// API Key protection middleware
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return await next();
  }
  return bearerAuth({ token: apiKey })(c, next);
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchQwenModels();
    return c.json({
      object: 'list',
      data: models
    });
  } catch (err: any) {
    return c.json({ error: { message: err.message } }, 500);
  }
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initPlaywright().then(async () => {
    console.log('Playwright initialized.');

    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;
    if (email && password && activePage) {
      const { loginToQwen } = await import('./services/playwright.ts');
      await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 60000 });

      const loginInputExists = await activePage.$('input[type="email"], input[placeholder*="Email"]');
      if (loginInputExists) {
        console.log('[Init] Login page detected, attempting API login...');
        const success = await loginToQwen(email, password);
        if (success) {
          console.log('[Init] Auto-login successful!');
        } else {
          console.log('[Init] Auto-login failed, will retry on first request.');
        }
      } else {
        const chatInput = await activePage.$('textarea:visible, [contenteditable="true"]');
        if (chatInput) {
          console.log('[Init] Already logged in.');
        } else {
          console.log('[Init] No chat input, attempting API login...');
          const success = await loginToQwen(email, password);
          if (success) {
            console.log('[Init] Auto-login successful!');
          } else {
            console.log('[Init] Auto-login failed, will retry on first request.');
          }
        }
      }
    }

    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
