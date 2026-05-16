/*
 * File: login.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { initPlaywright, closePlaywright, activePage, loginToQwen, BrowserType } from './services/playwright.ts';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;

  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  if (email && password) {
    console.log(`[Login] Credentials found in .env. Attempting automated API login using ${browserType}...`);
    await initPlaywright(true, browserType); // Can be headless
    const success = await loginToQwen(email, password);
    if (success) {
      console.log('[Login] Automated login successful! Session saved.');
      await closePlaywright();
      process.exit(0);
    } else {
      console.error('[Login] Automated login failed. Falling back to manual login...');
      await closePlaywright();
    }
  }

  console.log(`Opening ${browserType} to allow manual login...`);
  await initPlaywright(false, browserType); // false = not headless
  if (activePage) {
    await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  } else {
    console.error('Failed to get active page');
    process.exit(1);
  }
  console.log('Browser opened. Please login to chat.qwen.ai.');
  console.log('Once you are fully logged in and can see the chat interface, close the browser window or press Ctrl+C here.');
  
  // Wait indefinitely until user closes the process
  process.on('SIGINT', async () => {
    console.log('Closing browser...');
    await closePlaywright();
    process.exit(0);
  });
}

main();