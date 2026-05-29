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
import { QwenAccount } from '../core/accounts.ts';
import { config } from '../core/config.ts';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();

interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null;
  lastHeadersTime: number;
  refreshTimeout: NodeJS.Timeout | null;
}

const accountHeaderCaches = new Map<string, AccountHeaderCache>();

function getFallbackAccountId(): string | null {
  const first = accountPages.keys().next();
  return first.done ? null : first.value;
}

function resolvePage(accountId?: string): Page | null {
  if (accountId) {
    return accountPages.get(accountId) || null;
  }
  const fallbackAccountId = getFallbackAccountId();
  return activePage || (fallbackAccountId ? accountPages.get(fallbackAccountId) ?? null : null);
}

function getAccountHeaderCache(accountId: string): AccountHeaderCache {
  let cache = accountHeaderCaches.get(accountId);
  if (!cache) {
    cache = {
      currentHeaders: {},
      cachedQwenHeaders: null,
      lastHeadersTime: 0,
      refreshTimeout: null,
    };
    accountHeaderCaches.set(accountId, cache);
  }
  return cache;
}

const HEADERS_TTL = 30 * 60 * 1000;
const REFRESH_THRESHOLD = 0.7;

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

const uiMutex = new Mutex();

export async function getCookies(accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  const page = resolvePage(accountId);
  if (!page) return '';
  const cookies = await page.context().cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function getBasicHeaders(accountId?: string): Promise<{ cookie: string, userAgent: string, bxV: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36' };
  
  let page = resolvePage(accountId);
  if (accountId && !page) {
    const { getAccountCredentials } = await import('../core/accounts.ts');
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless);
      page = accountPages.get(accountId) ?? null;
    }
  }
  
  if (!page) throw new Error('Playwright not initialized');
  
  const cookie = await getCookies(accountId);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);
  const bxV = cache.currentHeaders['bx-v'] || '2.5.36';
  
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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  activePage = await context.newPage();

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
  for (const cache of accountHeaderCaches.values()) {
    if (cache.refreshTimeout) {
      clearTimeout(cache.refreshTimeout);
      cache.refreshTimeout = null;
    }
  }
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId);
  }
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  console.log(`[Playwright] Attempting API login for ${email}...`);
  
  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

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

export async function getQwenHeaders(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  if (!forceNew && cache.cachedQwenHeaders && (Date.now() - cache.lastHeadersTime < HEADERS_TTL * REFRESH_THRESHOLD)) {
    return cache.cachedQwenHeaders;
  }
  const release = await uiMutex.acquire();
  try {
    if (!forceNew && cache.cachedQwenHeaders && (Date.now() - cache.lastHeadersTime < HEADERS_TTL)) {
      release();
      return cache.cachedQwenHeaders;
    }
    return await _getQwenHeadersInternal(forceNew, accountId);
  } finally {
    release();
  }
}

async function _getQwenHeadersInternal(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

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

  if (!forceNew && cache.cachedQwenHeaders && (Date.now() - cache.lastHeadersTime < HEADERS_TTL)) {
    const age = Date.now() - cache.lastHeadersTime;
    if (age > HEADERS_TTL * REFRESH_THRESHOLD && !cache.refreshTimeout) {
      cache.refreshTimeout = setTimeout(() => {
        cache.refreshTimeout = null;
        getQwenHeaders(true, accountId).catch(() => {});
      }, HEADERS_TTL - age);
    }
    return cache.cachedQwenHeaders;
  }

  if (accountId && !accountPages.has(accountId)) {
    const { getAccountCredentials } = await import('../core/accounts.ts');
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless);
    }
  }

  const page = resolvePage(accountId);
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${cacheKey}`);
  }

  const currentUrl = page.url();
  const isOnQwen = currentUrl.includes('chat.qwen.ai');
  const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  if (!isOnQwen || forceNew || isOnSpecificChat) {
    console.log(`[Playwright] Navigating to Qwen home for ${cacheKey}... (Current: ${currentUrl})`);
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
  }

  const isLoginPage = page.url().includes('login') || (await page.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    if (!accountId) {
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
    } else {
      const { getAccountCredentials } = await import('../core/accounts.ts');
      const creds = getAccountCredentials(accountId);
      if (creds && creds.email && creds.password) {
        console.log(`[Playwright] Detected login page for account ${creds.email}. Attempting login...`);
        const acctContext = accountContexts.get(accountId);
        if (acctContext) {
          await loginToQwenWithContext(acctContext, page, creds.email, creds.password);
        }
      }
    }
  }

  console.log(`[Playwright] Waiting for chat input for ${cacheKey}...`);
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
  await page.waitForSelector(inputSelector, { timeout: 30000 }).catch(() => {
    console.error(`[Playwright] Chat input not found for ${cacheKey}. Current URL:`, page.url());
    throw new Error(`Timeout waiting for chat input for ${cacheKey}. Are you logged in?`);
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      console.error(`[Playwright] Timeout waiting for Qwen headers for ${cacheKey}. Current URL:`, page.url());
      try {
        const screenshotPath = path.resolve(`qwen_profiles/error_${cacheKey}.png`);
        await page.screenshot({ path: screenshotPath });
        console.log(`[Playwright] Error screenshot saved to ${screenshotPath}`);
      } catch (err: any) {
        console.error('[Playwright] Failed to save error screenshot:', err.message);
      }
      reject(new Error(`Timeout waiting for Qwen headers for ${cacheKey}`));
    }, 60000);

    console.log(`[Playwright] Setting up route interception for ${cacheKey}...`);
    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: string | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_id) {
            uiSessionId = payload.chat_id;
          }
          if (payload.parent_id !== undefined) {
            uiParentMessageId = payload.parent_id;
          }
        } catch (e) {
        }
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
        console.log(`[Playwright] Intercepted request missing critical headers for ${cacheKey}, skipping...`);
        await route.continue();
        return;
      }

      console.log(`[Playwright] Successfully intercepted headers for ${cacheKey}.`);
      cache.currentHeaders = extractedHeaders;
      cache.cachedQwenHeaders = { headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId };
      cache.lastHeadersTime = Date.now();
      if (cache.refreshTimeout) {
        clearTimeout(cache.refreshTimeout);
        cache.refreshTimeout = null;
      }

      import('./qwen.ts').then(m => m.disableNativeTools(accountId).catch(() => {}));

      await route.abort('aborted');
      
      await page.unroute('**/api/v2/chat/completions*', routeHandler);

      resolve(cache.cachedQwenHeaders);
    };

    page.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      console.log(`[Playwright] Triggering request for ${cacheKey}...`);
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
      
      await page.focus(inputSelector);
      await page.fill(inputSelector, '');
      await page.type(inputSelector, 'a', { delay: 100 });
      console.log(`[Playwright] Typed char for ${cacheKey}, waiting for UI to update...`);
      await sleep(2000);
      
      const selectors = [
        '.message-input-right-button-send .send-button',
        '.chat-prompt-send-button',
        'button.send-button'
      ];
      
      let clicked = false;
      for (const selector of selectors) {
        try {
          const btn = await page.$(selector);
          if (btn && await btn.isVisible()) {
            console.log(`[Playwright] Attempting click on: ${selector}`);
            
            await page.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) {
                element.focus();
                element.click();
              }
            }, selector);
            
            await btn.click({ force: true, delay: 50 }).catch(() => {});
            
            clicked = true;
            break;
          }
        } catch (e) {
          console.error(`[Playwright] Error clicking ${selector} for ${cacheKey}:`, e);
        }
      }

      if (!clicked) {
        console.log(`[Playwright] No send button found/clicked for ${cacheKey}, fallback to Enter...`);
        await page.focus(inputSelector);
        await page.keyboard.press('Enter');
      }
    });
  });
}

export async function initPlaywrightForAccount(account: QwenAccount, headless = true, browserType: BrowserType = 'chromium') {
  const profilePath = path.resolve('qwen_profiles', account.id);
  
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

  console.log(`[Playwright] Launching ${browserType} for account ${account.email}...`);

  const acctContext = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);

  const cookies = await acctContext.cookies();
  const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));

  if (!hasAuthCookie && account.email && account.password) {
    await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
  }
}

export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const profilePath = path.resolve('qwen_profiles', accountId);
  
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

  const acctContext = await browserEngine.launchPersistentContext(profilePath, {
    headless: false,
    channel,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  const acctPage = await acctContext.newPage();
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  return { context: acctContext, page: acctPage };
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  const cookies = await page.context().cookies();
  const hasSession = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  
  let email: string | null = null;
  if (hasSession) {
    try {
      email = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="user-email"], .user-email, [class*="email"]');
        return el?.textContent?.trim() || null;
      });
    } catch {
    }
  }
  
  return { email, hasSession };
}

export async function closePlaywrightForAccount(accountId: string) {
  const acctContext = accountContexts.get(accountId);
  if (acctContext) {
    await acctContext.close();
    accountContexts.delete(accountId);
    accountPages.delete(accountId);
  }
}

async function loginToQwenWithContext(acctContext: BrowserContext, acctPage: Page, email: string, password: string): Promise<boolean> {
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  const result = await acctPage.evaluate(async ({ email, password }) => {
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
    await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
    const isLogged = !(acctPage.url().includes('auth') || acctPage.url().includes('login'));
    if (isLogged) {
      console.log(`[Playwright] Login confirmed for ${email}.`);
      return true;
    }
  }

  console.error(`[Playwright] Login failed for ${email}:`, result.data || result.error);
  return false;
}
