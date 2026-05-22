/*
 * File: playwright.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null = null;
let lastHeadersTime = 0;
let refreshTimeout: NodeJS.Timeout | null = null;
const HEADERS_TTL = 60 * 60 * 1000; // 60 minutes
const REFRESH_THRESHOLD = 0.9; // Pre-refresh at 90% of TTL

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// Lock to prevent concurrent UI interactions
const uiMutex = new Mutex();

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

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('qwen_profile');
  
  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case 'firefox':
      browserEngine = firefox;
      break;
    case 'webkit':
      browserEngine = webkit;
      break;
    case 'chrome':
      browserEngine = chromium;
      channel = 'chrome';
      break;
    case 'edge':
      browserEngine = chromium;
      channel = 'msedge';
      break;
    case 'chromium':
    default:
      browserEngine = chromium;
      break;
  }

  console.log(`[Playwright] Launching ${browserType}...`);

  context = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  // Bypass navigator.webdriver detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  // Reuse the initial page (about:blank) instead of creating a new tab
  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();

  const hasCredentials = !!(process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD);
  const hasValidSession = await checkValidSession();

  if (!hasValidSession && !hasCredentials) {
    console.warn('[Playwright] No valid session AND no credentials in .env. Manual login will be required.');
  }

  if (!hasValidSession) {
    await attemptAutoLogin();
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const cookies = await activePage.context().cookies();
    const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
    if (!hasAuthCookie) return false;
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
    return isLogged;
  } catch {
    return false;
  }
}

async function attemptAutoLogin(): Promise<void> {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;
  if (!email || !password) return;
  console.log('[Playwright] Attempting auto-login with credentials from .env...');
  try {
    const success = await loginToQwen(email, password);
    if (success) {
      console.log('[Playwright] Auto-login successful.');
      return;
    }
    console.warn('[Playwright] API login failed, trying UI fallback...');
    const uiSuccess = await loginToQwenUI(email, password);
    if (uiSuccess) {
      console.log('[Playwright] UI login fallback successful.');
    } else {
      console.warn('[Playwright] Both API and UI login failed. Manual login may be required.');
    }
  } catch (err: any) {
    console.error('[Playwright] Auto-login error:', err.message);
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  console.log(`[Playwright] Attempting API login for ${email}...`);
  
  // Navigate to auth page to set up context/cookies
  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  // Qwen expects SHA256 hashed password
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
      return { ok: response.ok, data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword });

  if (result.ok) {
    console.log('[Playwright] API login request successful.');
    // Navigate to home to confirm session
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
    const isLogged = !(activePage.url().includes('auth') || activePage.url().includes('login'));
    if (isLogged) {
       console.log('[Playwright] Login confirmed.');
       return true;
    }
  }

  console.error('[Playwright] Login failed:', result.data || result.error);
  return false;
}

async function loginToQwenUI(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  console.log('[Playwright] Attempting UI login...');
  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  if (!activePage.url().includes('/auth')) {
    console.log('[Playwright] Already logged in');
    return true;
  }

  try {
    await activePage.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: 5000 });
  } catch {
    if (activePage.url().includes('/auth')) throw new Error('Email input not found');
    console.log('[Playwright] Already logged in');
    return true;
  }

  console.log('[Playwright] UI: Filling email...');
  await activePage.fill('input[type="email"], input[placeholder*="Email"]', email);
  await activePage.keyboard.press('Enter');
  await sleep(1000);

  await activePage.waitForSelector('input[type="password"]', { timeout: 10000 });
  console.log('[Playwright] UI: Filling password...');
  await activePage.fill('input[type="password"]', password);
  await activePage.keyboard.press('Enter');

  await sleep(2000);

  const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
  if (isLogged) {
    console.log('[Playwright] UI login OK');
    return true;
  }

  console.log('[Playwright] UI login failed');
  return false;
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getQwenHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  // Use a lock to ensure only one request uses the UI at a time
  const release = await uiMutex.acquire();

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
    const age = Date.now() - lastHeadersTime;
    if (age > HEADERS_TTL * REFRESH_THRESHOLD && !refreshTimeout) {
      refreshTimeout = setTimeout(() => {
        refreshTimeout = null;
        getQwenHeaders(true).catch(() => {});
      }, HEADERS_TTL - age);
    }
    return cachedQwenHeaders;
  }

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
    console.log(`[Playwright] Navigating to Qwen home... (Current: ${currentUrl})`);
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
  }

  // Check if we are on a login page and perform automated login if credentials provided
  const isLoginPage = activePage.url().includes('login') || (await activePage.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;
    
    if (email && password) {
      console.log('[Playwright] Detected login page. Attempting automated login...');
      try {
        const loggedIn = await loginToQwen(email, password);
        if (!loggedIn) {
          throw new Error('loginToQwen returned false');
        }
        console.log('[Playwright] Automated login successful.');
      } catch (err: any) {
        console.error('[Playwright] Automated login failed:', err.message);
      }
    } else {
      console.warn('[Playwright] Detected login page but QWEN_EMAIL/PASSWORD not provided in .env');
    }
  }

  // Wait for the textarea
  console.log('[Playwright] Waiting for chat input...');
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
  await activePage.waitForSelector(inputSelector, { timeout: 30000 }).catch(() => {
    console.error('[Playwright] Chat input not found. Current URL:', activePage!.url());
    throw new Error('Timeout waiting for chat input. Are you logged in?');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Qwen headers'));
    }, 60000);

    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      const postData = request.postData();

      const { chatId, parentId } = parseSessionIds(postData);

      const extractedHeaders = {
        'cookie': reqHeaders['cookie'] || '',
        'bx-ua': reqHeaders['bx-ua'] || '',
        'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
        'bx-v': reqHeaders['bx-v'] || '',
        'x-request-id': reqHeaders['x-request-id'] || '',
        'user-agent': reqHeaders['user-agent'] || ''
      };

      if (!extractedHeaders.cookie || !extractedHeaders['bx-ua']) {
        await route.continue();
        return;
      }

      currentHeaders = extractedHeaders;
      cachedQwenHeaders = {
        headers: extractedHeaders,
        chatSessionId: chatId,
        parentMessageId: parentId
      };
      lastHeadersTime = Date.now();

      import('./qwen.ts').then(m => m.disableNativeTools().catch(() => {}));

      await route.abort('aborted');
      await activePage!.unroute('**/api/v2/chat/completions*', routeHandler);

      resolve(cachedQwenHeaders);
    };

    activePage!.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      await sendChatMessage(activePage!, inputSelector);
    });
  });
}

async function sendChatMessage(page: Page, selector: string): Promise<void> {
  await page.focus(selector);
  await page.fill(selector, '');
  await page.type(selector, 'a', { delay: 100 });
  await sleep(2000); // Wait for Send button to enable

  const clicked = await tryClickSendButton(page);
  if (!clicked) {
    await page.keyboard.press('Enter');
  }
}

async function tryClickSendButton(page: Page): Promise<boolean> {
  const selectors = [
    '.message-input-right-button-send .send-button',
    '.chat-prompt-send-button',
    'button.send-button'
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement;
          el?.click();
        }, sel);
        await btn.click({ force: true, delay: 50 }).catch(() => {});
        return true;
      }
    } catch { /* ignore */ }
  }

  return false;
}

function parseSessionIds(postData: string | null): { chatId: string; parentId: string | null } {
  let chatId = '';
  let parentId: string | null = null;

  if (!postData) return { chatId, parentId };

  try {
    const payload = JSON.parse(postData);
    if (payload.chat_id) chatId = payload.chat_id;
    if (payload.parent_id !== undefined) parentId = payload.parent_id;
  } catch { /* ignore */ }

  return { chatId, parentId };
}
