import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import path from 'path';
import fs from 'fs';
import type { QwenAccount } from '../core/accounts.js';
import { config } from '../core/config.js';
import { getBaseAccountId } from '../core/account-lanes.js';
import { markAccountNotReady, markAccountReady } from '../core/account-manager.js';
import { getRuntimeInt, getRuntimeBool } from '../core/runtime-config.js';
import { getStealthScript } from './stealth.js';
import { rememberQwenVersions, refreshQwenVersions, getQwenWebVersion } from './qwen-versions.js';
import { solveAliyunWafCaptcha } from './captcha-solver.js';
import { registerHeaderStoreAccessor, noteAccessToken } from './auth-session.js';
import { getFingerprintProfile, type FingerprintProfile } from './fingerprint.js';
import { setFingerprintRotationListener } from '../core/account-isolation.js';
import { sleep } from '../utils/sleep.js';

export { sleep };
export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

interface BrowserEngineConfig {
  engine: typeof chromium | typeof firefox | typeof webkit;
  channel?: string;
}

export function resolveBrowserEngine(browserType: BrowserType): BrowserEngineConfig {
  switch (browserType) {
    case 'firefox': return { engine: firefox };
    case 'webkit': return { engine: webkit };
    case 'chrome': return { engine: chromium, channel: 'chrome' };
    case 'edge': return { engine: chromium, channel: 'msedge' };
    case 'chromium':
    default: return { engine: chromium };
  }
}

export interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null;
  lastHeadersTime: number;
  refreshInProgress: boolean;
}

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
export const CHROME_CLIENT_HINTS = '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"';
export const BROWSER_VIEWPORT = { width: 1366, height: 768 };
export const BROWSER_LOCALE = 'pt-BR';
export const BROWSER_TIMEZONE = 'America/Sao_Paulo';

export function getBrowserIdentity(accountId?: string): { userAgent: string; secChUa: string; platform: string; profile?: FingerprintProfile } {
  const profile = accountId ? getFingerprintProfile(accountId) : undefined;
  return {
    userAgent: profile?.userAgent || CHROME_UA,
    secChUa: profile?.secChUa || CHROME_CLIENT_HINTS,
    platform: profile?.platform || 'Windows',
    profile,
  };
}

export function getClientHintsHeaders(accountId?: string): Record<string, string> {
  const identity = getBrowserIdentity(accountId);
  return {
    'sec-ch-ua': identity.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${identity.platform}"`,
  };
}

function getBrowserLaunchArgs(): string[] {
  return Array.from(new Set([
    ...config.browser.args,
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-accelerated-2d-canvas',
  ]));
}

export function sharedContextOptions(accountId?: string): BrowserContextOptions {
  const identity = getBrowserIdentity(accountId);

  if (accountId && identity.profile) {
    const profile = identity.profile;
    return {
      userAgent: identity.userAgent,
      locale: BROWSER_LOCALE,
      timezoneId: BROWSER_TIMEZONE,
      viewport: profile.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: 'light',
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        ...config.browser.headers,
        ...getClientHintsHeaders(accountId),
      },
    };
  }
  return {
    userAgent: identity.userAgent,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    viewport: BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      ...config.browser.headers,
      ...getClientHintsHeaders(accountId),
    },
  };
}

export const HEADERS_TTL = config.headers.ttlMs;
export const COOKIE_CACHE_TTL = 5 * 60 * 1000;
export const REFRESH_THRESHOLD = 0.7;
export const GUEST_HEADERS_TTL = 30 * 60 * 1000;

// Header TTL / background refresh are read at call time so they can be tuned
// live from the admin dashboard without restarting the server.
export function getHeadersTtlMs(): number {
  return getRuntimeInt('HEADERS_TTL_MS', config.headers.ttlMs)
}
export function getBackgroundHeaderRefresh(): boolean {
  return getRuntimeBool('BACKGROUND_HEADER_REFRESH', config.headers.backgroundRefresh)
}

export const PROFILES_DIR = path.resolve(config.browser.userDataDir);

export const accountContexts = new Map<string, BrowserContext>();
export const accountPages = new Map<string, Page>();
export const accountHeaderCaches = new Map<string, AccountHeaderCache>();
export const cachedUserAgents = new Map<string, string>();
export const cookieCaches = new Map<string, { cookie: string, timestamp: number }>();

let browser: Browser | null = null;
let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let guestContext: BrowserContext | null = null;
let guestPage: Page | null = null;
let guestHeadersCache: { headers: Record<string, string>, timestamp: number } | null = null;

export function getBrowser(): Browser | null { return browser; }
export function setBrowser(b: Browser | null) { browser = b; }
export function getContext(): BrowserContext | null { return context; }
export function setContext(c: BrowserContext | null) { context = c; }
export function getActivePage(): Page | null { return activePage; }
export function setActivePage(p: Page | null) { activePage = p; }
export function getGuestContext(): BrowserContext | null { return guestContext; }
export function setGuestContext(c: BrowserContext | null) { guestContext = c; }
export function getGuestPage(): Page | null { return guestPage; }
export function setGuestPage(p: Page | null) { guestPage = p; }
export function getGuestHeadersCache(): { headers: Record<string, string>, timestamp: number } | null { return guestHeadersCache; }
export function setGuestHeadersCache(c: { headers: Record<string, string>, timestamp: number } | null) { guestHeadersCache = c; }

export function getAccountHeaderCache(accountId: string): AccountHeaderCache {
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

registerHeaderStoreAccessor((accountId: string) => {
  return getAccountHeaderCache(accountId);
});

/** Returns the account/lane ids that currently have cached anti-bot headers. */
export function listHeaderAccountIds(): string[] {
  return [...accountHeaderCaches.keys()];
}

/**
 * Installs a listener that captures the Qwen access token from the
 * `auth.qwen.ai/api/v2/auths/refresh` response. Qwen's frontend calls this
 * endpoint right after signin and the response body carries the JWT that is
 * later sent as `authorization: Bearer <token>`. The token is NOT persisted in
 * localStorage/cookies, so it has to be captured from the network response.
 *
 * The same listener also records the `version` and `bx-v` headers the live
 * client sends, which keeps those constants in sync with the deployment.
 */
export interface AccessTokenCapture {
  /** Last token seen, whether or not it is still valid. */
  getToken: () => string | null;
  /** Resolves with the next token observed, or null on timeout. */
  waitForToken: (timeoutMs?: number) => Promise<string | null>;
}

export function installAccessTokenCapture(page: Page): AccessTokenCapture {
  let accessToken: string | null = null;
  const waiters: Array<(token: string | null) => void> = [];

  const handler = async (res: any) => {
    const url = res.url();
    if (!url.includes('auth.qwen.ai/api/v2/auths/refresh')) return;
    try {
      const text = await res.text();
      const json = JSON.parse(text);
      const token = json?.data?.access_token;
      if (typeof token === 'string' && token.length > 20) {
        accessToken = token;
        while (waiters.length > 0) {
          const resolve = waiters.shift();
          resolve?.(token);
        }
      }
    } catch {
      /* ignore non-JSON responses */
    }
  };

  page.on('response', handler);

  const requestHandler = (req: any) => {
    const url = req.url();
    if (!url.includes('/api/v2/')) return;
    let headers: Record<string, string>;
    try {
      headers = req.headers();
    } catch {
      return;
    }
    rememberQwenVersions({
      webVersion: headers['version'] || null,
      bxVersion: headers['bx-v'] || null,
    });
  };

  page.on('request', requestHandler);

  return {
    getToken: () => accessToken,
    waitForToken: (timeoutMs = 15000) => new Promise<string | null>((resolve) => {
      if (accessToken) {
        resolve(accessToken);
        return;
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(onToken);
        if (index >= 0) waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      const onToken = (token: string | null) => {
        clearTimeout(timer);
        resolve(token);
      };
      waiters.push(onToken);
    }),
  };
}

/**
 * Forces a refresh of the Qwen access token and returns it. Requires the
 * `refresh_token` cookie that is set by the signin flow.
 *
 * Uses the browser context's APIRequestContext, which shares the cookie jar
 * but is not subject to CORS preflight rules the way page-context fetch is.
 */
export async function refreshQwenAccessToken(page: Page, timeoutMs = 15000): Promise<string | null> {
  try {
    const response = await page.context().request.get('https://auth.qwen.ai/api/v2/auths/refresh', {
      headers: {
        'accept': 'application/json',
        'source': 'web',
        'version': getQwenWebVersion(),
        'x-request-origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
      },
      timeout: timeoutMs,
    });

    const text = await response.text();
    try {
      const json = JSON.parse(text);
      const token = json?.data?.access_token;
      return typeof token === 'string' && token.length > 20 ? token : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Renews the access token by letting the Qwen web client perform the
 * refresh itself.
 *
 * The refresh endpoint only accepts requests that originate from the real
 * web client: a request built by the proxy is rejected with "Invalid request
 * header". Reloading the page makes the frontend issue the refresh call
 * with its own headers, and the resulting token is captured from the
 * response.
 */
export async function renewAccessTokenViaPage(page: Page, timeoutMs = 20000): Promise<string | null> {
  const capture = installAccessTokenCapture(page);
  const pending = capture.waitForToken(timeoutMs);

  try {
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    /* navigation errors are handled by the wait below */
  }

  return pending;
}

export function storageStatePath(accountId: string): string {
  return path.join(PROFILES_DIR, `${accountId}_state.json`);
}

export function loadStorageState(accountId: string): string | undefined {
  const p = storageStatePath(accountId);
  if (!fs.existsSync(p)) return undefined;

  try {
    const raw = fs.readFileSync(p, 'utf8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') {
      console.warn(`[Playwright] Invalid storageState structure for ${accountId}, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }
    if (!Array.isArray(state.cookies)) {
      console.warn(`[Playwright] StorageState for ${accountId} missing cookies array, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }
    if (!Array.isArray(state.origins)) {
      state.origins = [];
    }

    const now = Date.now();
    const validCookies = state.cookies.filter((c: any) => {
      if (!c || !c.name || !c.value) return false;
      if (c.expires && c.expires > 0 && c.expires * 1000 < now) return false;
      return true;
    });

    if (validCookies.length === 0) {
      console.warn(`[Playwright] StorageState for ${accountId} has no valid cookies, discarding.`);
      fs.rmSync(p, { force: true });
      return undefined;
    }

    if (validCookies.length !== state.cookies.length) {
      console.log(`[Playwright] Pruned ${state.cookies.length - validCookies.length} expired cookies for ${accountId}.`);
      state.cookies = validCookies;
      fs.writeFileSync(p, JSON.stringify(state, null, 2));
    }

    return p;
  } catch (err: any) {
    console.warn(`[Playwright] Failed to read storageState for ${accountId}: ${err.message}. Discarding.`);
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    return undefined;
  }
}

export async function saveStorageState(ctx: BrowserContext, accountId: string): Promise<void> {
  try {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
    await ctx.storageState({ path: storageStatePath(accountId) });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to save storageState for ${accountId}: ${err.message}`);
  }
}

export async function clearPageRuntimeState(page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;

  try {
    await page.context().clearCookies();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear cookies during profile reset: ${err.message}`);
  }

  try {
    await page.context().clearPermissions();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear permissions during profile reset: ${err.message}`);
  }

  try {
    await page.evaluate(() => {
      try { window.localStorage.clear(); } catch { /* ignore */ }
      try { window.sessionStorage.clear(); } catch { /* ignore */ }
    });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear page storage during profile reset: ${err.message}`);
  }
}

export async function getOrLaunchBrowser(browserType: BrowserType = 'chromium'): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const { engine, channel } = resolveBrowserEngine(browserType);
  console.log(`[Playwright] Launching shared ${browserType} browser...`);

  const launchArgs = getBrowserLaunchArgs();

  browser = await engine.launch({
    headless: config.browser.headless,
    channel,
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features'],
    args: launchArgs,
  });
  browser.on('disconnected', () => {
    browser = null;
    accountContexts.clear();
    accountPages.clear();
    accountHeaderCaches.clear();
    cookieCaches.clear();
    cachedUserAgents.clear();
    context = null;
    activePage = null;
    guestContext = null;
    guestPage = null;
    for (const id of [...accountPages.keys(), '_default', 'guest']) {
      markAccountNotReady(id);
    }
  });
  return browser;
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
export function getUiMutex(accountId: string): Mutex {
  let m = uiMutexes.get(accountId);
  if (!m) {
    m = new Mutex();
    uiMutexes.set(accountId, m);
  }
  return m;
}

export async function checkSessionAuthenticated(page: Page | null): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    return await page.evaluate(async () => {
      try {
        const res = await fetch('/api/v2/users/status');
        const data = await res.json();
        return data?.data === true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export async function hasValidAuthCookie(page: Page | null): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    const cookies = await page.context().cookies();
    const hasCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
    if (hasCookie) return true;
    const hasStorage = await page.evaluate(() => !!localStorage.getItem('token')).catch(() => false);
    return hasStorage;
  } catch {
    return false;
  }
}

/**
 * Checks for the `refresh_token` cookie, which is the only artifact that
 * allows minting a fresh Qwen access token. The `users/status` endpoint can
 * report an authenticated session using legacy cookies that can no longer
 * obtain an access token, so it is not a reliable signal on its own.
 */
export async function hasRefreshTokenCookie(page: Page | null): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    const cookies = await page.context().cookies();
    return cookies.some(c => c.name === 'refresh_token' && (c.expires === -1 || c.expires > Date.now() / 1000));
  } catch {
    return false;
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const hasAuth = await hasValidAuthCookie(activePage);
    if (!hasAuth) return false;
    await activePage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    return await checkSessionAuthenticated(activePage);
  } catch {
    return false;
  }
}

export async function loginToQwenWithContext(acctContext: BrowserContext, acctPage: Page, email: string, password: string): Promise<boolean> {
  console.log(`[Playwright] Starting UI login for ${email}...`);
  try {
    await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
  } catch (err: any) {
    console.warn(`[Playwright] Navigation to auth page warning: ${err.message}`);
  }
  await sleep(1000);

  // Only skip the interactive login when we still hold a refresh_token cookie,
  // which is what allows minting a fresh access token. A session that only has
  // legacy cookies passes /api/v2/users/status but cannot call the API.
  if (await hasRefreshTokenCookie(acctPage) && await checkSessionAuthenticated(acctPage)) {
    console.log(`[Playwright] Already authenticated for ${email}.`);
    return true;
  }

  // Switch to password login mode if on verification code mode
  try {
    const passwordBtn = acctPage.locator('button:has-text("senha"), button:has-text("password"), button:has-text("Password"), a:has-text("senha"), a:has-text("password")');
    if (await passwordBtn.count() > 0 && await passwordBtn.first().isVisible().catch(() => false)) {
      console.log(`[Playwright] Switching to password mode for ${email}...`);
      await passwordBtn.first().click().catch(() => {});
      await sleep(1000);
    }
  } catch (err: any) {
    console.warn(`[Playwright] Error switching to password login: ${err.message}`);
  }

  // Fill email and password in the UI inputs
  const emailSel = 'input[name="email"], input[type="text"], input[type="email"]';
  await acctPage.waitForSelector(emailSel, { timeout: config.timeouts.page });
  await acctPage.fill(emailSel, email);
  await sleep(300);

  const passSel = 'input[name="password"], input[type="password"]';
  await acctPage.waitForSelector(passSel, { timeout: config.timeouts.page });
  await acctPage.fill(passSel, password);
  await sleep(300);

  // Click submit
  console.log(`[Playwright] Submitting credentials for ${email}...`);
  // Only target the real submit button. Text-based selectors such as
  // "Fazer login" also match the login-mode tabs, which would silently
  // prevent the form from being submitted.
  const submitBtn = acctPage.locator('button.qwenchat-auth-pc-submit-button, button[type="submit"]');
  if (await submitBtn.count() > 0) {
    await submitBtn.first().click().catch(() => {});
  } else {
    await acctPage.keyboard.press('Enter');
  }

  // Wait for navigation away from auth page (signin processing)
  try {
    await acctPage.waitForURL(url => !url.href.includes('/auth') && !url.href.includes('/login'), { timeout: 15000 });
  } catch {
    /* navigation may not change URL if signin returns JSON */
  }

  // Poll for authentication or solve any Aliyun WAF captcha that appears
  for (let i = 0; i < 25; i++) {
    await sleep(1000);

    const hasCaptcha = await acctPage.locator('#aliyunCaptcha-sliding-slider, #waf_nc_block').count() > 0;
    if (hasCaptcha) {
      console.log(`[Playwright] Aliyun captcha detected during login for ${email}, attempting solve...`);
      await solveAliyunWafCaptcha(acctPage);
    }

    // The signin flow sets the refresh_token cookie; wait for it so the caller
    // can mint an access token.
    if (await hasRefreshTokenCookie(acctPage)) {
      console.log(`[Playwright] Login confirmed for ${email}.`);
      return true;
    }
    if (await checkSessionAuthenticated(acctPage)) {
      const url = acctPage.url();
      if (!url.includes('/auth') && !url.includes('/login')) {
        console.log(`[Playwright] Login confirmed for ${email}.`);
        return true;
      }
    }
  }

  console.error(`[Playwright] Login timed out or failed for ${email}`);
  return false;
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
    await activePage.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: config.timeouts.page });
  } catch {
    if (activePage.url().includes('/auth')) throw new Error('Email input not found');
    console.log('[Playwright] Already logged in');
    return true;
  }

  console.log('[Playwright] UI: Filling email...');
  await activePage.fill('input[type="email"], input[placeholder*="Email"]', email);
  await activePage.keyboard.press('Enter');
  await sleep(1000);

  await activePage.waitForSelector('input[type="password"]', { timeout: config.timeouts.page });
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

export async function resetBrowserProfile(cacheKey: string, accountId?: string): Promise<void> {
  const profileId = accountId === 'guest' ? '_guest' : (accountId || '_default');
  const profilePath = path.join(PROFILES_DIR, profileId);

  try {
    if (accountId === 'guest') {
      await clearPageRuntimeState(guestPage);
      if (guestContext) {
        await guestContext.close();
        guestContext = null;
      }
      guestPage = null;
    } else if (accountId) {
      const acctPage = accountPages.get(accountId) ?? null;
      await clearPageRuntimeState(acctPage);
      const acctContext = accountContexts.get(accountId);
      if (acctContext) {
        await acctContext.close();
        accountContexts.delete(accountId);
      }
      accountPages.delete(accountId);
    } else {
      await clearPageRuntimeState(activePage);
      if (context) {
        await context.close();
        context = null;
      }
      activePage = null;
    }

    // IMPORTANT: the shared browser and the OTHER accounts' contexts/pages must
    // stay alive. This reset targets a single account (or the default/guest
    // context) — closing the whole browser here kills every in-flight stream on
    // every other account and forces a full cold restart, which is what this
    // recovery path is trying to avoid.
    accountHeaderCaches.delete(cacheKey);
    cookieCaches.delete(cacheKey);
    cachedUserAgents.delete(cacheKey);
    if (accountId === 'guest') {
      guestHeadersCache = null;
    }
    markAccountNotReady(accountId || cacheKey);
    markAccountNotReady(profileId);
    fs.rmSync(profilePath, { recursive: true, force: true });
    fs.rmSync(storageStatePath(profileId), { force: true });

    console.warn(`[Playwright] Cleared browser profile for ${cacheKey}: ${profilePath}`);
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear browser profile for ${cacheKey}: ${err.message}`);
  }
}

export async function initPlaywright(_headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const sharedBrowser = await getOrLaunchBrowser(browserType);
  console.log(`[Playwright] Creating default context on shared browser...`);

  const storageState = loadStorageState('_default');
  const defaultProfile = getFingerprintProfile('_default');
  context = await sharedBrowser.newContext({
    ...sharedContextOptions('_default'),
    ...(storageState ? { storageState } : {}),
  });

  await context.addInitScript(getStealthScript(defaultProfile));

  activePage = await context.newPage();

  const hasCredentials = !!(process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD);
  const hasValidSession = await checkValidSession();

  if (!hasValidSession && !hasCredentials) {
    console.warn('[Playwright] No valid session AND no credentials in .env. Manual login will be required.');
  }

  if (!hasValidSession) {
    await attemptAutoLogin();
  }

  if (await hasValidAuthCookie(activePage)) {
    await saveStorageState(context, '_default');
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const cache of accountHeaderCaches.values()) {
    cache.refreshInProgress = false;
  }
  if (context) {
    const ctx = context;
    context = null;
    activePage = null;
    try {
      if (await hasValidAuthCookie(activePage)) {
        await saveStorageState(ctx, '_default');
      }
    } catch {
      /* the browser may already be gone */
    }
    // The browser can be closed before this runs (crash, forced shutdown);
    // closing an already closed context must not abort the shutdown.
    await ctx.close().catch(() => {});
  }
  if (guestContext) {
    const gctx = guestContext;
    guestContext = null;
    guestPage = null;
    try {
      if (await hasValidAuthCookie(guestPage)) {
        await saveStorageState(gctx, '_guest');
      }
    } catch {
      /* the browser may already be gone */
    }
    await gctx.close().catch(() => {});
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId);
  }
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export async function dismissAgeModal(page: Page): Promise<void> {
  try {
    const modal = page.locator('.age-confirmation-modal');
    if (await modal.count() > 0 && await modal.first().isVisible({ timeout: 1500 }).catch(() => false)) {
      const continueBtn = page.locator('.age-confirmation-modal .qwen-chat-v2-btn-black:has-text("Continuar")');
      if (await continueBtn.count() > 0) {
        await continueBtn.first().click();
        await page.waitForTimeout(500);
        console.log('[Playwright] Age confirmation modal dismissed.');
      }
    }
  } catch { /* ignore */ }
}

export async function initPlaywrightForAccount(account: QwenAccount, _headless = true, browserType: BrowserType = 'chromium') {
  const sharedBrowser = await getOrLaunchBrowser(browserType);
  const baseAccountId = getBaseAccountId(account.id);

  console.log(`[Playwright] Creating context for account ${account.email} on shared browser...`);

  const storageState = loadStorageState(baseAccountId);
  const acctProfile = getFingerprintProfile(account.id);
  const acctContext = await sharedBrowser.newContext({
    ...sharedContextOptions(account.id),
    ...(storageState ? { storageState } : {}),
  });

  await acctContext.addInitScript(getStealthScript(acctProfile));

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);
  touchAccountActivity(account.id);

  // Capture the Qwen access token from the auth refresh response. Qwen's
  // frontend calls auth.qwen.ai/api/v2/auths/refresh right after signin and
  // the response body carries the JWT used as `authorization: Bearer <token>`.
  const tokenCapture = installAccessTokenCapture(acctPage);

  const storeAccessToken = (token: string | null): boolean => {
    if (!token) return false;
    const cache = getAccountHeaderCache(account.id);
    cache.currentHeaders['authorization'] = `Bearer ${token}`;
    cache.lastHeadersTime = Date.now();
    noteAccessToken(account.id, token, 'login-capture');
    markAccountReady(account.id);
    return true;
  };

  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });

  // Detect the live Qwen web version and Aliyun Baxia version so the
  // `version` and `bx-v` headers always match what the deployment expects.
  await refreshQwenVersions(acctPage).catch(() => undefined);

  // Always attempt UI login when credentials are available. The Bearer token
  // (authorization header) is only issued by the signin flow, so a cached
  // session without a valid refresh_token cookie cannot produce API calls.
  if (account.email && account.password) {
    const ok = await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
    if (ok) {
      // The signin flow triggers auth.qwen.ai/api/v2/auths/refresh, whose
      // response body contains the access token.
      for (let i = 0; i < 20; i++) {
        if (tokenCapture.getToken()) break;
        await sleep(500);
      }
      let token = tokenCapture.getToken();
      if (!token) {
        token = await refreshQwenAccessToken(acctPage);
      }
      if (storeAccessToken(token)) {
        console.log(`[Playwright] Captured Qwen access token for ${account.email}.`);
      } else {
        console.warn(`[Playwright] Could not capture Qwen access token for ${account.email} after login.`);
      }
      await saveStorageState(acctContext, baseAccountId);
    }
  }

  try {
    await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    await dismissAgeModal(acctPage);
    await sleep(1500);
    const isAuth = await checkSessionAuthenticated(acctPage);
    if (!isAuth) {
      if (account.email && account.password) {
        console.log(`[Playwright] Session expired or unauthenticated for ${account.email}, logging in...`);
        const ok = await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
        if (ok) {
          await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
          await dismissAgeModal(acctPage);
          await saveStorageState(acctContext, baseAccountId);
        }
      } else {
        console.warn(`[Playwright] Session expired for account ${account.id} but no credentials available for re-login.`);
      }
    } else {
      console.log(`[Playwright] Session validated for ${account.email}.`);
      await saveStorageState(acctContext, baseAccountId);
    }
  } catch (err: any) {
    console.warn(`[Playwright] Failed to validate session for ${account.email}: ${err.message}`);
  }

  // If we still have no access token (e.g. session was already valid and the
  // refresh happened before the listener was installed), force a refresh.
  if (!getAccountHeaderCache(account.id).currentHeaders['authorization']) {
    for (let i = 0; i < 20; i++) {
      if (tokenCapture.getToken()) break;
      await sleep(500);
    }
    let token = tokenCapture.getToken();
    if (!token) {
      token = await refreshQwenAccessToken(acctPage);
    }
    if (storeAccessToken(token)) {
      console.log(`[Playwright] Captured Qwen access token for ${account.email}.`);
    }
  }

  if (await hasValidAuthCookie(acctPage)) {
    await saveStorageState(acctContext, baseAccountId);
  }
}

export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const { engine, channel } = resolveBrowserEngine(browserType);

  const manualBrowser = await engine.launch({
    headless: false,
    channel,
    ignoreDefaultArgs: ['--enable-automation'],
    args: getBrowserLaunchArgs(),
  });

  const storageState = loadStorageState(accountId);
  const manualProfile = getFingerprintProfile(accountId);
  const acctContext = await manualBrowser.newContext({
    ...sharedContextOptions(accountId),
    ...(storageState ? { storageState } : {}),
  });

  await acctContext.addInitScript(getStealthScript(manualProfile));

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
    } catch { /* ignore */ }
  }

  return { email, hasSession };
}

export async function closePlaywrightForAccount(accountId: string) {
  const acctContext = accountContexts.get(accountId);
  const acctPage = accountPages.get(accountId);
  if (acctContext) {
    try {
      if (await hasValidAuthCookie(acctPage || null)) {
        await saveStorageState(acctContext, accountId);
      }
    } catch {
      /* the browser may already be gone */
    }
    await acctContext.close().catch(() => {});
  }
  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  accountHeaderCaches.delete(accountId);
  cookieCaches.delete(accountId);
  cachedUserAgents.delete(accountId);
  markAccountNotReady(accountId);
}

export function getPageForAccount(accountId?: string): Page | null {
  if (accountId === 'guest') return guestPage;
  if (accountId) return accountPages.get(accountId) || null;
  return activePage;
}

// Contingency hook: when the isolation system rotates an account's device
// fingerprint (hard block — captcha/flagged/cookie-invalid), close that
// account's Playwright context(s) — including every lane — and drop its cached
// headers/cookies so the next request rebuilds a brand-new context carrying the
// freshly rotated fingerprint. This is strictly scoped to the base account id, so
// a blocked account never disturbs any other account's browser resources.
setFingerprintRotationListener((baseId) => {
  for (const key of [...accountContexts.keys()]) {
    const keyBase = getBaseAccountId(key) || key;
    if (keyBase === baseId) {
      closePlaywrightForAccount(key).catch(() => { /* ignore */ });
    }
  }
  accountHeaderCaches.delete(baseId);
  cookieCaches.delete(baseId);
  cachedUserAgents.delete(baseId);
});

const accountLastActivity = new Map<string, number>();

export function touchAccountActivity(accountId?: string): void {
  if (accountId) {
    accountLastActivity.set(accountId, Date.now());
  }
}

export function getAccountLastActivity(accountId: string): number | undefined {
  return accountLastActivity.get(accountId);
}

export async function hibernateAccountContext(accountId: string): Promise<boolean> {
  const acctContext = accountContexts.get(accountId);
  const acctPage = accountPages.get(accountId);
  if (!acctContext) return false;

  try {
    if (await hasValidAuthCookie(acctPage || null)) {
      await saveStorageState(acctContext, accountId);
    }
  } catch (err: any) {
    console.warn(`[Playwright] Failed saving storage state during hibernation for ${accountId}:`, err.message);
  }

  try {
    await acctContext.close();
  } catch (err: any) {
    console.warn(`[Playwright] Failed closing context during hibernation for ${accountId}:`, err.message);
  }

  accountContexts.delete(accountId);
  accountPages.delete(accountId);
  console.log(`[Playwright] Hibernated idle browser context for account ${accountId} (freed RAM).`);
  return true;
}

export async function hibernateIdleAccountContexts(maxIdleMs?: number): Promise<number> {
  const idleMs = maxIdleMs ?? config.browser.idleHibernateMs;
  if (!idleMs || idleMs <= 0) return 0;
  const now = Date.now();
  let count = 0;

  for (const accountId of [...accountContexts.keys()]) {
    const lastActive = accountLastActivity.get(accountId) ?? now;
    if (now - lastActive >= idleMs) {
      const hibernated = await hibernateAccountContext(accountId);
      if (hibernated) count++;
    }
  }

  return count;
}

if (config.browser.idleHibernateMs > 0 && typeof setInterval !== 'undefined') {
  const timer = setInterval(() => {
    hibernateIdleAccountContexts().catch((err: any) => {
      console.warn('[Playwright] Idle hibernation check error:', err.message);
    });
  }, 60000);
  if (timer.unref) timer.unref();
}

/**
 * Returns the account's page once it is actually on the chat.qwen.ai origin.
 * A lane's page can transiently sit off-origin (mid-`goto`, `about:blank` while
 * header interception is warming it, etc.); routing a chat request at that
 * moment makes `createQwenStream` refuse with "Cannot fetch Qwen completion
 * outside an active Qwen browser page". Wait briefly and — if possible — drive
 * the existing page back to a stable Qwen page instead of failing immediately.
 */
export async function waitForAccountPage(accountId?: string, timeoutMs = 15000): Promise<Page | null> {
  const deadline = Date.now() + timeoutMs;
  let attemptedNavigation = false;

  for (;;) {
    let page = accountId === 'guest' ? guestPage : accountId ? accountPages.get(accountId) : activePage;
    if ((!page || page.isClosed()) && accountId && accountId !== 'guest') {
      const { getAccountCredentials } = await import('../core/accounts.js');
      const creds = getAccountCredentials(getBaseAccountId(accountId));
      if (creds) {
        await initPlaywrightForAccount({ ...creds, id: accountId }, config.browser.headless);
        page = accountPages.get(accountId);
      }
    }
    if (page && !page.isClosed()) {
      touchAccountActivity(accountId);
      if (page.url().includes('chat.qwen.ai')) {
        return page;
      }
      if (!attemptedNavigation) {
        attemptedNavigation = true;
        page.goto('https://chat.qwen.ai/c/new-chat', {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(15000, config.timeouts.navigation),
        }).catch(() => { /* ignore navigation errors; polling continues */ });
      }
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(250);
  }
}
