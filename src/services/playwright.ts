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
import { QwenAccount } from '../core/accounts.js';
import { config } from '../core/config.js';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

interface BrowserEngineConfig {
  engine: typeof chromium | typeof firefox | typeof webkit;
  channel?: string;
}

function resolveBrowserEngine(browserType: BrowserType): BrowserEngineConfig {
  switch (browserType) {
    case 'firefox': return { engine: firefox };
    case 'webkit': return { engine: webkit };
    case 'chrome': return { engine: chromium, channel: 'chrome' };
    case 'edge': return { engine: chromium, channel: 'msedge' };
    case 'chromium':
    default: return { engine: chromium };
  }
}

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();

interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null;
  lastHeadersTime: number;
  refreshInProgress: boolean;
}

const accountHeaderCaches = new Map<string, AccountHeaderCache>();
const cachedUserAgents = new Map<string, string>();

function getAccountHeaderCache(accountId: string): AccountHeaderCache {
  let cache = accountHeaderCaches.get(accountId);
  if (!cache) {
    cache = {
      currentHeaders: {},
      cachedQwenHeaders: null,
      lastHeadersTime: 0,
      refreshInProgress: false,
    };
    accountHeaderCaches.set(accountId, cache);
  }
  return cache;
}

const HEADERS_TTL = 5 * 60 * 1000;
const COOKIE_CACHE_TTL = 5 * 60 * 1000;
const cookieCaches = new Map<string, { cookie: string, timestamp: number }>();
const REFRESH_THRESHOLD = 0.7;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
export const CHROME_CLIENT_HINTS = '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"';

function getStealthScript(): string {
  return `
    try {
      delete navigator.__proto__.webdriver;
    } catch(e) {}
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en'],
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

    window.chrome = {
      runtime: { onConnect: {}, onMessage: {} },
      loadTimes: function() { return {}; },
      csi: function() { return {}; },
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
    };

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
        : originalQuery(parameters);

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.apply(this, arguments);
      };
    }

    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });

    (function() {
      function makeMime(desc, suffixes, type) {
        const m = { description: desc, suffixes: suffixes, type: type };
        return m;
      }
      const pdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
      const pdfxMime = makeMime('Portable Document Format', 'pdf', 'text/pdf');
      const pdfPlugin = {
        name: 'PDF Viewer',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer',
        length: 2,
        0: pdfMime,
        1: pdfxMime,
      };
      pdfMime.enabledPlugin = pdfPlugin;
      pdfxMime.enabledPlugin = pdfPlugin;

      const chromePdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
      const chromePdfMime2 = makeMime('Portable Document Format', 'pdf', 'text/pdf');
      const chromePdfPlugin = {
        name: 'Chrome PDF Viewer',
        description: 'Portable Document Format',
        filename: 'internal-pdf-viewer',
        length: 2,
        0: chromePdfMime,
        1: chromePdfMime2,
      };
      chromePdfMime.enabledPlugin = chromePdfPlugin;
      chromePdfMime2.enabledPlugin = chromePdfPlugin;

      const nativePlugin = {
        name: 'Native Client',
        description: '',
        filename: 'internal-nacl-plugin',
        length: 2,
        0: makeMime('Native Client Executable', '', 'application/x-nacl'),
        1: makeMime('Portable Native Client Executable', '', 'application/x-pnacl'),
      };
      nativePlugin[0].enabledPlugin = nativePlugin;
      nativePlugin[1].enabledPlugin = nativePlugin;

      const pluginsList = [pdfPlugin, chromePdfPlugin, nativePlugin];
      const mimeList = [pdfMime, pdfxMime, chromePdfMime, chromePdfMime2, nativePlugin[0], nativePlugin[1]];

      function makeNamedNodeMap(items, namedEntries) {
        const arr = [...items];
        for (const [k, v] of namedEntries) arr[k] = v;
        arr.item = function(i) { return this[i] || null; };
        arr.namedItem = function(name) { return this[name] || null; };
        arr.refresh = function() {};
        return arr;
      }

      const pluginEntries = pluginsList.map((p, i) => [p.name, p]);
      const mimeEntries = mimeList.map((m) => [m.type, m]);

      const pluginsArr = makeNamedNodeMap(pluginsList, pluginEntries);
      const mimeArr = makeNamedNodeMap(mimeList, mimeEntries);

      Object.defineProperty(navigator, 'plugins', { get: () => pluginsArr });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArr });
    })();

    (function() {
      const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      const _toBlob = HTMLCanvasElement.prototype.toBlob;
      const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

      function addNoise(canvas) {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const style = ctx.fillStyle;
          ctx.fillStyle = 'rgba(255,255,255,0.01)';
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = style;
        } catch(e) {}
      }

      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        addNoise(this);
        return _toDataURL.apply(this, args);
      };
      HTMLCanvasElement.prototype.toBlob = function(...args) {
        addNoise(this);
        return _toBlob.apply(this, args);
      };
    })();

    (function() {
      if (typeof OfflineAudioContext === 'undefined') return;
      const _startRendering = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        return _startRendering.apply(this, arguments).then(buffer => {
          try {
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
              const data = buffer.getChannelData(ch);
              for (let i = 0; i < Math.min(data.length, 100); i++) {
                data[i] += (Math.random() - 0.5) * 1e-7;
              }
            }
          } catch(e) {}
          return buffer;
        });
      };
    })();
  `;
}

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

const uiMutexes = new Map<string, Mutex>();
function getUiMutex(accountId: string): Mutex {
  let m = uiMutexes.get(accountId);
  if (!m) {
    m = new Mutex();
    uiMutexes.set(accountId, m);
  }
  return m;
}

export async function getCookies(accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  const cacheKey = accountId || 'global';
  const now = Date.now();
  const cached = cookieCaches.get(cacheKey);
  if (cached && (now - cached.timestamp) < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }
  const page = accountId ? accountPages.get(accountId) : activePage;
  if (!page) return '';
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  cookieCaches.set(cacheKey, { cookie: cookieStr, timestamp: now });
  return cookieStr;
}

export async function getBasicHeaders(accountId?: string): Promise<{ cookie: string, userAgent: string, bxV: string, bxUa?: string, bxUmidtoken?: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36' };
  
  let page = accountId ? accountPages.get(accountId) : activePage;
  if (accountId && !page) {
    const { getAccountCredentials } = await import('../core/accounts.ts');
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless);
      page = accountPages.get(accountId);
    }
  }
  
  if (!page) throw new Error('Playwright not initialized');
  
  const cookie = await getCookies(accountId);
  const cacheKey = accountId || 'global';
  
  let userAgent = cachedUserAgents.get(cacheKey);
  if (!userAgent) {
    userAgent = await page.evaluate(() => navigator.userAgent);
    cachedUserAgents.set(cacheKey, userAgent);
  }
  
  const cache = getAccountHeaderCache(cacheKey);
  let bxUa = cache.currentHeaders['bx-ua'];
  let bxUmidtoken = cache.currentHeaders['bx-umidtoken'];
  const bxV = cache.currentHeaders['bx-v'] || '2.5.36';
  
  // Auto-recover missing anti-fraud headers by triggering full header interception
  if (!bxUa || !bxUmidtoken) {
    console.log(`[Playwright] Missing bx-ua/bx-umidtoken for ${cacheKey}, triggering header interception...`);
    try {
      const result = await getQwenHeaders(true, accountId);
      bxUa = result.headers['bx-ua'];
      bxUmidtoken = result.headers['bx-umidtoken'];
      return {
        cookie: await getCookies(accountId),
        userAgent,
        bxV: result.headers['bx-v'] || bxV,
        bxUa,
        bxUmidtoken,
      };
    } catch (err: any) {
      console.warn(`[Playwright] Failed to auto-recover headers for ${cacheKey}: ${err.message}`);
    }
  }
  
  return { cookie, userAgent, bxV, bxUa, bxUmidtoken };
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('qwen_profiles', '_default');
  const { engine, channel } = resolveBrowserEngine(browserType);

  console.log(`[Playwright] Launching ${browserType}...`);

  context = await engine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: CHROME_UA,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ]
  });

  await context.addInitScript(getStealthScript());

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
    cache.refreshInProgress = false;
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
  return loginToQwenWithContext(activePage.context(), activePage, email, password);
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

let guestContext: BrowserContext | null = null;
let guestPage: Page | null = null;
let guestHeadersCache: { headers: Record<string, string>, timestamp: number } | null = null;
const GUEST_HEADERS_TTL = 30 * 60 * 1000;

export async function getGuestHeaders(): Promise<Record<string, string>> {
  if (guestHeadersCache && (Date.now() - guestHeadersCache.timestamp) < GUEST_HEADERS_TTL) {
    return guestHeadersCache.headers;
  }

  if (!guestPage) {
    const profilePath = path.resolve('qwen_profiles', '_guest');
    const { engine, channel } = resolveBrowserEngine('chromium');
    guestContext = await engine.launchPersistentContext(profilePath, {
      headless: config.browser.headless,
      channel,
      userAgent: CHROME_UA,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins,site-per-process', '--disable-infobars', '--no-first-run', '--no-default-browser-check']
    });
    await guestContext.addInitScript(getStealthScript());
    guestPage = await guestContext.newPage();
    
    await guestPage.goto('https://chat.qwen.ai/c/guest', { waitUntil: 'domcontentloaded' });
    
    try {
      const keepSessionBtn = await guestPage.$('button:has-text("Manter sessão terminada"), button:has-text("Keep session ended"), button:has-text("Manter sessão encerrada")');
      if (keepSessionBtn) {
        await keepSessionBtn.click();
        console.log('[Playwright] Guest: Clicked "Manter sessão terminada"');
        await sleep(1000);
      }
    } catch (e) {
      // Modal might not be there
    }
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout getting guest headers')), 30000);
    
    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      const reqHeaders = request.headers();
      console.log('[Playwright] Guest intercepted request:', request.url());
      
      const extractedHeaders = {
        'cookie': reqHeaders['cookie'] || '',
        'bx-ua': reqHeaders['bx-ua'] || '',
        'bx-umidtoken': reqHeaders['bx-umidtoken'] || '',
        'bx-v': reqHeaders['bx-v'] || '2.5.36',
        'user-agent': reqHeaders['user-agent'] || CHROME_UA,
      };
      
      if (extractedHeaders['bx-ua']) {
        console.log('[Playwright] Guest: Successfully captured bx-ua');
        guestHeadersCache = { headers: extractedHeaders, timestamp: Date.now() };
        await route.abort('aborted');
        await guestPage!.unroute('**/api/v2/chat/completions*', routeHandler);
        
        import('./qwen.js').then(m => m.disableNativeTools('guest').catch(() => {}));
        
        resolve(extractedHeaders);
      } else {
        console.log('[Playwright] Guest: Request missing bx-ua, continuing route. Headers:', Object.keys(reqHeaders));
        await route.continue();
        // If it's the completions request and we still don't have bx-ua, we might need to resolve anyway 
        // or the UI interaction failed to trigger the SDK.
        if (request.url().includes('/api/v2/chat/completions')) {
           console.warn('[Playwright] Guest: Completions request made without bx-ua. Resolving with available headers.');
           guestHeadersCache = { headers: extractedHeaders, timestamp: Date.now() };
           await guestPage!.unroute('**/api/v2/chat/completions*', routeHandler);
           resolve(extractedHeaders);
        }
      }
    };

    guestPage!.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';
      try {
        await guestPage!.waitForSelector(inputSelector, { timeout: 10000 });
        await guestPage!.focus(inputSelector);
        await guestPage!.fill(inputSelector, '');
        await guestPage!.type(inputSelector, 'a', { delay: 50 });
        await sleep(1000);
        
        const selectors = ['.message-input-right-button-send .send-button', '.chat-prompt-send-button', 'button.send-button'];
        let clicked = false;
        for (const selector of selectors) {
          const btn = await guestPage!.$(selector);
          if (btn && await btn.isVisible()) {
            await btn.click({ force: true, delay: 50 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          await guestPage!.keyboard.press('Enter');
        }
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  });
}

export async function getQwenHeaders(forceNew = false, accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (accountId === 'guest') {
    const headers = await getGuestHeaders();
    return { headers, chatSessionId: 'guest-session', parentMessageId: null };
  }

  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  if (!forceNew && cache.cachedQwenHeaders) {
    const age = Date.now() - cache.lastHeadersTime;
    if (age < HEADERS_TTL) {
      if (age > HEADERS_TTL * REFRESH_THRESHOLD && !cache.refreshInProgress) {
        cache.refreshInProgress = true;
        getQwenHeaders(true, accountId).catch((err) => {
          console.warn(`[Playwright] Background header refresh failed for ${cacheKey}:`, (err as Error).message);
        }).finally(() => {
          cache.refreshInProgress = false;
        });
      }
      return cache.cachedQwenHeaders;
    }
  }

  const release = await getUiMutex(cacheKey).acquire();
  try {
    if (!forceNew && cache.cachedQwenHeaders && (Date.now() - cache.lastHeadersTime < HEADERS_TTL)) {
      return cache.cachedQwenHeaders;
    }
    return await _getQwenHeadersInternal(forceNew, accountId);
  } finally {
    release();
  }
}

/**
 * Lightweight cookie/cookie refresh via direct API call instead of full browser automation.
 * This attempts to extract cookies from the page context without triggering route interception.
 */
async function tryLightweightCookieRefresh(accountId?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null> {
  const cacheKey = accountId || 'global';
  const cache = getAccountHeaderCache(cacheKey);

  const page = accountId ? accountPages.get(accountId) : activePage;
  if (!page) return null;

  try {
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    let userAgent = cachedUserAgents.get(cacheKey);
    if (!userAgent) {
      userAgent = await page.evaluate(() => navigator.userAgent);
      cachedUserAgents.set(cacheKey, userAgent);
    }

    const now = Date.now();
    cookieCaches.set(cacheKey, { cookie: cookieStr, timestamp: now });

    if (cache.cachedQwenHeaders && cache.currentHeaders.cookie) {
      const updatedHeaders = {
        ...cache.cachedQwenHeaders.headers,
        cookie: cookieStr,
        'user-agent': userAgent,
      };
      cache.cachedQwenHeaders = {
        ...cache.cachedQwenHeaders,
        headers: updatedHeaders,
      };
      cache.lastHeadersTime = now;
      cache.currentHeaders = {
        ...cache.currentHeaders,
        cookie: cookieStr,
        'user-agent': userAgent,
      };
      return cache.cachedQwenHeaders;
    }
  } catch {
    // Lightweight refresh failed, fall back to full interception
  }

  return null;
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

  // If headers are cached and not forceNew, try lightweight cookie refresh first
  if (!forceNew && cache.cachedQwenHeaders) {
    const lightResult = await tryLightweightCookieRefresh(accountId);
    if (lightResult) {
      return lightResult;
    }
  }

  if (accountId && !accountPages.has(accountId)) {
    const { getAccountCredentials } = await import('../core/accounts.ts');
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless);
    }
  }

  const page = accountId ? accountPages.get(accountId) : activePage;
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${cacheKey}`);
  }

  const currentUrl = page.url();
  const isOnQwen = currentUrl.includes('chat.qwen.ai');
  const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  if (!isOnQwen || forceNew) {
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
      const { getAccountCredentials } = await import('../core/accounts.js');
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
      cache.refreshInProgress = false;

      import('./qwen.js').then(m => m.disableNativeTools(accountId).catch(() => {}));

      await route.abort('aborted');

      await page.unroute('**/api/v2/chat/completions*', routeHandler);

      resolve(cache.cachedQwenHeaders);
    };

    page.route('**/api/v2/chat/completions*', routeHandler).then(async () => {
      console.log(`[Playwright] Triggering request for ${cacheKey}...`);
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible';

      await page.focus(inputSelector);
      await page.fill(inputSelector, '');
      await page.type(inputSelector, 'a', { delay: 20 });
      console.log(`[Playwright] Typed char for ${cacheKey}, waiting for UI to update...`);
      await sleep(800);

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
  const { engine, channel } = resolveBrowserEngine(browserType);

  console.log(`[Playwright] Launching ${browserType} for account ${account.email}...`);

  const acctContext = await engine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: CHROME_UA,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ]
  });

  await acctContext.addInitScript(getStealthScript());

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);

  const cookies = await acctContext.cookies();
  const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));

  if (!hasAuthCookie && account.email && account.password) {
    await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
  }

  // Navigate to Qwen home to validate session and populate cookies
  try {
    await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const url = acctPage.url();
    if (url.includes('auth') || url.includes('login')) {
      if (account.email && account.password) {
        console.log(`[Playwright] Session expired for ${account.email}, re-logging in...`);
        await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
        await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } else {
        console.warn(`[Playwright] Session expired for account ${account.id} but no credentials available for re-login.`);
      }
    } else {
      console.log(`[Playwright] Session validated for ${account.email}.`);
    }
  } catch (err: any) {
    console.warn(`[Playwright] Failed to validate session for ${account.email}: ${err.message}`);
  }
}

export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const profilePath = path.resolve('qwen_profiles', accountId);
  const { engine, channel } = resolveBrowserEngine(browserType);

  const acctContext = await engine.launchPersistentContext(profilePath, {
    headless: false,
    channel,
    userAgent: CHROME_UA,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ]
  });

  await acctContext.addInitScript(getStealthScript());

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

export function getPageForAccount(accountId?: string): Page | null {
  if (accountId === 'guest') return guestPage;
  if (accountId) return accountPages.get(accountId) || null;
  return activePage;
}

const streamCallbacks = new Map<string, {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
  onMeta: (meta: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  onBody: (body: string) => void;
}>();

const abortControllers = new Map<string, () => void>();

const pagesWithExposed = new WeakSet<Page>();

async function ensureStreamBridge(page: Page): Promise<void> {
  if (pagesWithExposed.has(page)) return;
  pagesWithExposed.add(page);
  await page.exposeFunction('__streamRelay', (reqId: string, type: string, data: any) => {
    const cb = streamCallbacks.get(reqId);
    if (!cb) return;
    switch (type) {
      case 'meta': cb.onMeta(data); break;
      case 'chunk': cb.onChunk(data); break;
      case 'end': cb.onEnd(); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
      case 'error': cb.onError(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
      case 'body': cb.onBody(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); break;
    }
  });
}

export async function browserFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; statusText: string; contentType: string; body: string; headers: Record<string, string> }> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();

  return page.evaluate(async ({ url, options, reqId }: any) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
    try {
      const resp = await fetch(url, {
        method: options.method || 'POST',
        headers: options.headers || {},
        body: options.body || undefined,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
      const body = await resp.text();
      return {
        status: resp.status,
        statusText: resp.statusText,
        contentType: resp.headers.get('content-type') || '',
        body,
        headers: respHeaders,
      };
    } catch (e: any) {
      clearTimeout(timeoutId);
      throw new Error(`browserFetch failed: ${e.message}`);
    }
  }, { url, options, reqId });
}

export async function browserStreamFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  body: string;
  reqId: string;
  abort: () => void;
}> {
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();

  let metaResolve!: (value: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  const metaPromise = new Promise<{ status: number; statusText: string; contentType: string; headers: Record<string, string> }>((resolve) => {
    metaResolve = resolve;
  });

  const metaTimeout = setTimeout(() => {
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
    metaResolve({ status: 0, statusText: 'Timeout', contentType: '', headers: {} });
  }, options.timeoutMs || 130000);

  streamCallbacks.set(reqId, {
    onMeta: (meta) => {
      clearTimeout(metaTimeout);
      metaResolve(meta);
    },
    onChunk: () => {},
    onEnd: () => {},
    onError: () => {},
    onBody: () => {},
  });

  let abortFn = () => {};
  let bodyResolve!: (value: string) => void;
  const bodyPromise = new Promise<string>((resolve) => { bodyResolve = resolve; });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cb = streamCallbacks.get(reqId);
      if (!cb) return;
      cb.onChunk = (chunk: string) => {
        try { controller.enqueue(enc.encode(chunk)); } catch {}
      };
      cb.onEnd = () => {
        try { controller.close(); } catch {}
        streamCallbacks.delete(reqId);
        abortControllers.delete(reqId);
      };
      cb.onError = (msg: string) => {
        try { controller.error(new Error(msg)); } catch {}
        streamCallbacks.delete(reqId);
        abortControllers.delete(reqId);
      };
      cb.onBody = (text: string) => {
        bodyResolve(text);
        streamCallbacks.delete(reqId);
        abortControllers.delete(reqId);
      };

      page.evaluate(async ({ url, options, reqId }: any) => {
        const controller = new AbortController();
        (window as any).__abortControllers = (window as any).__abortControllers || {};
        (window as any).__abortControllers[reqId] = controller;
        const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 130000);
        try {
          const resp = await fetch(url, {
            method: options.method || 'POST',
            headers: options.headers || {},
            body: options.body || undefined,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          const respHeaders: Record<string, string> = {};
          resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
          (window as any).__streamRelay(reqId, 'meta', {
            status: resp.status,
            statusText: resp.statusText,
            contentType: resp.headers.get('content-type') || '',
            headers: respHeaders,
          });

          if (!resp.ok || !resp.body) {
            const bodyText = await resp.text();
            (window as any).__streamRelay(reqId, 'body', bodyText);
            delete (window as any).__abortControllers[reqId];
            return;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              (window as any).__streamRelay(reqId, 'end', null);
              break;
            }
            (window as any).__streamRelay(reqId, 'chunk', decoder.decode(value, { stream: true }));
          }
          delete (window as any).__abortControllers[reqId];
        } catch (e: any) {
          clearTimeout(timeoutId);
          (window as any).__streamRelay(reqId, 'error', e.message);
          delete (window as any).__abortControllers[reqId];
        }
      }, { url, options, reqId }).catch((e: any) => {
        const cb = streamCallbacks.get(reqId);
        if (cb) {
          cb.onError(e.message);
        }
      });
    },
    cancel() {
      page.evaluate((reqId: string) => {
        const c = (window as any).__abortControllers?.[reqId];
        if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
      }, reqId).catch(() => {});
      streamCallbacks.delete(reqId);
      abortControllers.delete(reqId);
    },
  });

  const meta = await metaPromise;

  abortFn = () => {
    page.evaluate((reqId: string) => {
      const c = (window as any).__abortControllers?.[reqId];
      if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
    }, reqId).catch(() => {});
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
  };

  abortControllers.set(reqId, abortFn);

  return {
    ...meta,
    stream,
    body: meta.contentType.includes('text/event-stream') ? '' : await bodyPromise,
    reqId,
    abort: abortFn,
  };
}
