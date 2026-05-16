/*
 * File: playwright.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null = null;
let lastHeadersTime = 0;
const HEADERS_TTL = 10 * 60 * 1000; // 10 minutes

// Lock to prevent concurrent UI interactions
let uiLock: Promise<void> = Promise.resolve();

export async function getCookies(): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (!activePage) return '';
  const cookies = await activePage.context().cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function getBasicHeaders(): Promise<{ cookie: string, userAgent: string, bxV: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36' };
  if (!activePage) throw new Error('Playwright not initialized');
  
  const cookie = await getCookies();
  const userAgent = await activePage.evaluate(() => navigator.userAgent);
  const bxV = currentHeaders['bx-v'] || '2.5.36';
  
  return { cookie, userAgent, bxV };
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('qwen_profile');

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
    ],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  activePage = await context.newPage();
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  const result = await activePage.evaluate(async ({ email, password }) => {
    try {
      const response = await fetch("https://chat.qwen.ai/api/v2/auths/signin", {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "source": "web",
          "timezone": new Date().toString().split(' (')[0],
          "x-request-id": crypto.randomUUID()
        },
        body: JSON.stringify({ email, password, login_type: "email" })
      });
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword });

  if (result.ok) {
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const currentUrl = activePage.url();
    const isLogged = !(currentUrl.includes('auth') || currentUrl.includes('login'));
    if (isLogged) {
      const chatInput = await activePage.$('textarea:visible, [contenteditable="true"]');
      if (chatInput) {
        console.log('[Playwright] Login confirmed.');
        return true;
      }
    }
  }

  console.error('[Playwright] Login failed:', result.data || result.error);
  return false;
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getQwenHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  // Use a lock to ensure only one request uses the UI at a time
  const release = await new Promise<() => void>(resolve => {
    uiLock = uiLock.then(() => new Promise<void>(innerResolve => {
      resolve(innerResolve);
    }));
  });

  try {
    return await _getQwenHeadersInternal(forceNew);
  } finally {
    release();
  }
}

async function _getQwenHeadersInternal(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return {
      headers: {
        'authorization': 'Bearer MOCK',
        'cookie': 'token=mock',
        'user-agent': 'mock',
        'bx-v': '2.5.36'
      },
      chatSessionId: mockSessionId,
      parentMessageId: null
    };
  }

  if (!forceNew && cachedQwenHeaders && (Date.now() - lastHeadersTime < HEADERS_TTL)) {
    return cachedQwenHeaders;
  }

  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  // Clear cache and retry if needed
  let retries = 2;
  while (retries >= 0) {
    try {
      return await _fetchQwenHeaders(forceNew);
    } catch (err: any) {
      if (err.message === 'RETRY_HEADER_FETCH' && retries > 0) {
        console.log('[Playwright] Retrying header fetch...');
        retries--;
        cachedQwenHeaders = null;
        lastHeadersTime = 0;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to fetch Qwen headers after retries');
}

async function _fetchQwenHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  const currentUrl = activePage.url();
  const isOnQwen = currentUrl.includes('chat.qwen.ai');
  const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  // If we already have cookies and basic headers, and we are not forced to refresh,
  // we can try to return what we have if it's recent enough.
  // However, for completions we often need the latest PoW/bx headers.

  if (!isOnQwen || forceNew || isOnSpecificChat) {
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  // Check if we are on a login page and perform automated login if credentials provided
  const isLoginPage = activePage.url().includes('login') || (await activePage.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;

    if (email && password) {
      console.log('[Playwright] Session expired, attempting UI login...');
      try {
        await activePage.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: 10000 });
        await activePage.fill('input[type="email"], input[placeholder*="Email"]', email);
        await activePage.keyboard.press('Enter');
        await activePage.waitForTimeout(1000);
        await activePage.waitForSelector('input[type="password"]', { timeout: 10000 });
        await activePage.fill('input[type="password"]', password);
        await activePage.keyboard.press('Enter');
        await activePage.waitForSelector('textarea:visible', { timeout: 30000 });
        console.log('[Playwright] UI login successful.');
      } catch (err: any) {
        console.error('[Playwright] UI login failed:', err.message);
      }
    } else {
      console.warn('[Playwright] Login page but no credentials in .env');
    }
  }

  // Wait for the textarea
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
  await activePage.waitForSelector(inputSelector, { timeout: 30000 }).catch(() => {
    console.error('[Playwright] Chat input not found. Current URL:', activePage!.url());
    throw new Error('Timeout waiting for chat input. Are you logged in?');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error('[Playwright] Timeout waiting for Qwen headers. Current URL:', activePage!.url());
      reject(new Error('Timeout waiting for Qwen headers'));
    }, 60000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: string | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_id) uiSessionId = payload.chat_id;
          if (payload.parent_id !== undefined) uiParentMessageId = payload.parent_id;
        } catch (e) {}
      }

      const extractedHeaders = {
        'cookie': reqHeaders['cookie'] || '',
        'bx-ua': reqHeaders['bx-ua'] || '',
        'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
        'bx-v': reqHeaders['bx-v'] || '',
        'x-request-id': reqHeaders['x-request-id'] || '',
        'user-agent': reqHeaders['user-agent'] || ''
      };

      if (!extractedHeaders.cookie || !extractedHeaders['bx-ua']) {
        console.log('[Playwright] Missing critical headers, retrying...');
        cachedQwenHeaders = null;
        lastHeadersTime = 0;
        await route.abort('aborted');
        reject(new Error('RETRY_HEADER_FETCH'));
        return;
      }

      console.log('[Playwright] Headers intercepted.');
      currentHeaders = extractedHeaders;
      cachedQwenHeaders = { headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId };
      lastHeadersTime = Date.now();

      import('./qwen.ts').then(m => m.disableNativeTools().catch(() => {}));

      await route.abort('aborted');
      await activePage!.unroute('**/api/v2/chat/completions*', routeHandler);
      resolve(cachedQwenHeaders);
    };

    activePage!.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
      await activePage!.focus(inputSelector);
      await activePage!.fill(inputSelector, '');
      await activePage!.type(inputSelector, 'a', { delay: 100 });
      await activePage!.waitForTimeout(2000);

      const selectors = ['.message-input-right-button-send .send-button', '.chat-prompt-send-button', 'button.send-button'];
      let clicked = false;
      for (const selector of selectors) {
        try {
          const btn = await activePage!.$(selector);
          if (btn && await btn.isVisible()) {
            await activePage!.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) { element.focus(); element.click(); }
            }, selector);
            await btn.click({ force: true, delay: 50 }).catch(() => {});
            clicked = true;
            break;
          }
        } catch (e) {}
      }

      if (!clicked) {
        await activePage!.focus(inputSelector);
        await activePage!.keyboard.press('Enter');
      }
    });
  });
}
