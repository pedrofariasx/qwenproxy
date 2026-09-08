import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { QwenAccount } from '../core/accounts.js';
import { config } from '../core/config.js';
import { getBaseAccountId } from '../core/account-lanes.js';
import { markAccountNotReady } from '../core/account-manager.js';
import { getRuntimeInt, getRuntimeBool } from '../core/runtime-config.js';
import { getStealthScript } from './stealth.js';
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

/** Returns the account/lane ids that currently have cached anti-bot headers. */
export function listHeaderAccountIds(): string[] {
  return [...accountHeaderCaches.keys()];
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

export async function hasValidAuthCookie(page: Page | null): Promise<boolean> {
  if (!page) return false;
  try {
    const cookies = await page.context().cookies();
    return cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  } catch {
    return false;
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const hasAuth = await hasValidAuthCookie(activePage);
    if (!hasAuth) return false;
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
    return isLogged;
  } catch {
    return false;
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
    const { getAccountCredentials } = await import("../core/accounts.js");
    const hasCreds = accountId ? !!getAccountCredentials(getBaseAccountId(accountId))?.password : false;
    const isManualNamedAccount = Boolean(accountId && accountId !== "guest" && !hasCreds);
    if (isManualNamedAccount) {
      console.warn(`[Playwright] Preserving cookies/storage for manual login account: ${cacheKey}`);
    } else {
      fs.rmSync(profilePath, { recursive: true, force: true });
      fs.rmSync(storageStatePath(profileId), { force: true });
      console.warn(`[Playwright] Cleared browser profile for ${cacheKey}: ${profilePath}`);
    }
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
    if (await hasValidAuthCookie(activePage)) {
      await saveStorageState(context, '_default');
    }
    await context.close();
    context = null;
    activePage = null;
  }
  if (guestContext) {
    if (await hasValidAuthCookie(guestPage)) {
      await saveStorageState(guestContext, '_guest');
    }
    await guestContext.close();
    guestContext = null;
    guestPage = null;
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId);
  }
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
  }
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

  const hasAuth = await hasValidAuthCookie(acctPage);

  if (!hasAuth && account.email && account.password) {
    await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
  }

  let navigated = false;
  try {
    await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    navigated = true;
    const url = acctPage.url();
    if (url.includes('auth') || url.includes('login')) {
      if (account.email && account.password) {
        console.log(`[Playwright] Session expired for account ${account.id}, re-logging in...`);
        await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
        await acctPage.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
        navigated = true;
      } else {
        console.warn(`[Playwright] Session expired for account ${account.id} but no credentials available for re-login.`);
      }
    } else {
      console.log(`[Playwright] Session validated for account ${account.id}.`);
    }
  } catch (err: any) {
    console.warn(`[Playwright] Failed to validate session for account ${account.id}: ${err.message}`);
  }

  const finalUrl = acctPage.url();
  const sessionOk = navigated && !finalUrl.includes("auth") && !finalUrl.includes("login") && finalUrl.startsWith("http");
  if (sessionOk && (await hasValidAuthCookie(acctPage))) {
    await saveStorageState(acctContext, baseAccountId);
    const { markAccountReady } = await import("../core/account-manager.js");
    markAccountReady(account.id);
    markAccountReady(baseAccountId);
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
    if (await hasValidAuthCookie(acctPage || null)) {
      await saveStorageState(acctContext, accountId);
    }
    await acctContext.close();
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
    const page = accountId === 'guest' ? guestPage : accountId ? accountPages.get(accountId) : activePage;
    if (page && !page.isClosed()) {
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
