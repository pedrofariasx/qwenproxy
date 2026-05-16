/*
 * File: playwright.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-14
 *
 * EACH CHAT KEY = ITS OWN ISOLATED BROWSER CONTEXT.
 * No more single-page contention. Auth cookies are shared
 * across contexts so each one starts already logged in.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';

// ──  Globals  ───────────────────────────────────────────────
let browser: Browser | null = null;
const HEADERS_TTL = 10 * 60 * 1000;     // 10 min per-header cache
const DEFAULT_KEY = '__default__';

/** Read at runtime so tests can override TTL via env var after module load. */
function idleTtl(): number {
  const testTtl = process.env.TEST_IDLE_TTL_MS;
  return testTtl ? parseInt(testTtl, 10) : 10 * 60 * 1000;
}
const AUTH_FILE = path.resolve('qwen_profile', 'auth.json');

let currentHeaders: Record<string, string> = {};

// Auth state – full Playwright storageState (cookies + localStorage + sessionStorage)
let sharedStorageState: any = null;
let sharedUserAgent = '';
let sharedBxV = '';

// ──  Per-context state  ─────────────────────────────────────
interface ContextHeaders {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}

interface ManagedCtx {
  key: string;
  ctx: BrowserContext;
  page: Page;
  lock: Promise<void>;
  cached: ContextHeaders | null;
  cachedAt: number;
  lastUsedAt: number;
}

const managed = new Map<string, ManagedCtx>();

// ──  Auth persistence helpers  ──────────────────────────────

async function saveStorageState(ctx: BrowserContext): Promise<void> {
  try {
    await fs.mkdir(path.dirname(AUTH_FILE), { recursive: true });
    const state = await ctx.storageState();
    await fs.writeFile(AUTH_FILE, JSON.stringify(state, null, 2), 'utf-8');
    const cookieCount = state.cookies?.length ?? 0;
    const originCount = state.origins?.length ?? 0;
    if (sharedStorageState) {
      console.log(`[Playwright] Updated saved auth (${cookieCount}c, ${originCount}o)`);
    } else {
      console.log(`[Playwright] Auth state saved for the first time (${cookieCount}c, ${originCount}o)`);
    }
    sharedStorageState = state;
  } catch {
    /* best-effort */
  }
}

async function loadStorageState(): Promise<void> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf-8');
    sharedStorageState = JSON.parse(raw);
  } catch {
    sharedStorageState = null;
  }
}

// ──  Context lifecycle  ─────────────────────────────────────

async function spawnCtx(key: string): Promise<ManagedCtx> {
  if (!browser) throw new Error('Playwright not initialized');

  const ctxOpts: any = {
    userAgent:
      sharedUserAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };

  // Restore full storage state (cookies + localStorage) so the page is fully logged in
  if (sharedStorageState) {
    const cookieCount = sharedStorageState.cookies?.length ?? 0;
    const originCount = sharedStorageState.origins?.length ?? 0;
    console.log(`[Playwright] Spawning context "${key}" with saved auth (${cookieCount} cookies, ${originCount} origins)`);
    ctxOpts.storageState = sharedStorageState;
  } else {
    console.log(`[Playwright] Spawning context "${key}" without saved auth (will need login)`);
  }

  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const state: ManagedCtx = {
    key,
    ctx,
    page,
    lock: Promise.resolve(),
    cached: null,
    cachedAt: 0,
    lastUsedAt: Date.now(),
  };
  managed.set(key, state);

  if (key === DEFAULT_KEY) {
    currentHeaders = {};
  }
  return state;
}

function resolveKey(pageKey?: string | null): string {
  if (!pageKey) return DEFAULT_KEY;
  const k = pageKey.trim();
  return k || DEFAULT_KEY;
}

async function getCtx(pageKey?: string | null): Promise<ManagedCtx> {
  const key = resolveKey(pageKey);
  const s = managed.get(key);
  if (s) {
    s.lastUsedAt = Date.now();
    return s;
  }
  return spawnCtx(key);
}

async function reapIdle(): Promise<void> {
  const now = Date.now();
  let reaped = 0;
  for (const [key, s] of managed) {
    if (key === DEFAULT_KEY) continue;
    const idleFor = now - s.lastUsedAt;
    if (idleFor > idleTtl()) {
      try {
        await s.ctx.close();
        console.log(`[Playwright] Reaped idle context "${key}" (idle for ${Math.round(idleFor / 1000)}s)`);
      } catch { /* ignore */ }
      managed.delete(key);
      reaped++;
    }
  }
  if (reaped > 0) {
    console.log(`[Playwright] Idle cleanup: ${reaped} context(s) closed, ${managed.size} remaining.`);
  }
}

// ──  Public API  ────────────────────────────────────────────

/**
 * Ensure we have valid auth before accepting requests.
 * If no saved auth exists, attempts to log in using credentials from .env.
 * Returns true if auth is available after this call.
 */
export async function loginIfNeeded(): Promise<boolean> {
  if (sharedStorageState) {
    const cookieCount = sharedStorageState.cookies?.length ?? 0;
    console.log(`[Playwright] Auth already available (${cookieCount} cookies).`);
    return true;
  }

  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;

  if (!email || !password) {
    console.warn('[Playwright] No QWEN_EMAIL/QWEN_PASSWORD in .env — manual login via npm run login may be needed.');
    return false;
  }

  console.log('[Playwright] No saved auth found. Attempting automatic login…');
  const ok = await loginToQwen(email, password);
  if (ok) {
    console.log('[Playwright] Auto-login successful. Auth saved for future contexts.');
  } else {
    console.error('[Playwright] Auto-login failed. Requests may fail until login is done manually.');
  }
  return ok;
}

/** Build a cookie header string from the shared storage state. */
export async function getCookies(): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (!sharedStorageState?.cookies) return '';
  return sharedStorageState.cookies
    .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    .join('; ');
}

export async function getBasicHeaders(): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
}> {
  if (process.env.TEST_MOCK_PLAYWRIGHT)
    return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36' };

  // If we don't have shared UA yet, try extracting from the default page
  if (!sharedUserAgent || !sharedBxV) {
    const d = managed.get(DEFAULT_KEY);
    if (d) {
      try {
        const ua = await d.page.evaluate(() => navigator.userAgent);
        if (ua) sharedUserAgent = ua;
      } catch { /* page might not be ready */ }
    }
  }

  return {
    cookie: await getCookies(),
    userAgent: sharedUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    bxV: sharedBxV || '2.5.36',
  };
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (browser) return;

  await loadStorageState();

  browser = await chromium.launch({ headless });

  if (sharedStorageState) {
    // Pre-create the default context so it's ready
    await spawnCtx(DEFAULT_KEY);
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  managed.clear();
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// активная страница для login.ts
export async function getActivePage(): Promise<Page | null> {
  const d = managed.get(DEFAULT_KEY);
  return d?.page ?? null;
}
export const activePage: Page | null = null; // kept for import compat – use getActivePage()

export async function loginToQwen(
  email: string,
  password: string,
): Promise<boolean> {
  const ctx = await getCtx(DEFAULT_KEY);
  const page = ctx.page;

  console.log(`[Playwright] Attempting API login for ${email}...`);

  await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'networkidle' });

  const hashedPassword = crypto
    .createHash('sha256')
    .update(password)
    .digest('hex');

  const result = await page.evaluate(
    async ({ email, password }) => {
      try {
        const res = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            source: 'web',
            timezone: new Date().toString().split(' (')[0],
            'x-request-id': crypto.randomUUID(),
          },
          body: JSON.stringify({ email, password, login_type: 'email' }),
        });
        const data = await res.json();
        return { ok: res.ok, data };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
    { email, password: hashedPassword },
  );

  if (result.ok) {
    console.log('[Playwright] API login request successful.');
    // Use domcontentloaded — networkidle can timeout on Qwen's long-poll connections
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Give the page a moment to finish rendering
    await page.waitForTimeout(3000);
    const isLogged =
      !page.url().includes('auth') && !page.url().includes('login');
    if (isLogged) {
      console.log('[Playwright] Login confirmed.');
      await saveStorageState(ctx.ctx);
      return true;
    }
  }

  console.error('[Playwright] Login failed:', result.data || result.error);
  return false;
}

// ──  Header interception (the core flow)  ───────────────────

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 * Each unique pageKey gets its own isolated BrowserContext.
 */
export async function getQwenHeaders(
  forceNew = false,
  pageKey?: string | null,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return {
      headers: {
        authorization: 'Bearer MOCK',
        cookie: 'token=mock',
        'user-agent': 'mock',
        'bx-v': '2.5.36',
      },
      chatSessionId: mockSessionId,
      parentMessageId: null,
    };
  }

  await reapIdle();
  const m = await getCtx(pageKey);

  // Per-context serial lock
  const release = await new Promise<() => void>((resolve) => {
    m.lock = m.lock.then(
      () => new Promise<void>((r) => resolve(r)),
    );
  });

  try {
    m.lastUsedAt = Date.now();
    return await doIntercept(m, forceNew);
  } finally {
    release();
  }
}

async function doIntercept(
  m: ManagedCtx,
  forceNew: boolean,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  if (!forceNew && m.cached && Date.now() - m.cachedAt < HEADERS_TTL) {
    return m.cached;
  }

  const page = m.page;
  const curUrl = page.url();
  const isOnQwen = curUrl.includes('chat.qwen.ai');
  const isOnChat = isOnQwen && /\/c\//.test(curUrl);

  if (!isOnQwen || forceNew || isOnChat) {
    console.log(`[Playwright] Navigating to Qwen home… (was: ${curUrl})`);
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
  }

  // Auto-login if we land on the login page
  if (
    page.url().includes('login') ||
    (await page.$('input[type="email"], input[placeholder*="Email"]'))
  ) {
    const email = process.env.QWEN_EMAIL;
    const password = process.env.QWEN_PASSWORD;
    if (email && password) {
      console.log('[Playwright] Login page detected → automating login…');
      try {
        await page.waitForSelector(
          'input[type="email"], input[placeholder*="Email"]',
          { timeout: 10000 },
        );
        await page.fill('input[type="email"], input[placeholder*="Email"]', email);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        await page.fill('input[type="password"]', password);
        await page.keyboard.press('Enter');
        await page.waitForSelector('textarea:visible', { timeout: 30000 });
        console.log('[Playwright] Auto-login finished.');
        await saveStorageState(m.ctx);
      } catch (err: any) {
        console.error('[Playwright] Auto-login failed:', err.message);
      }
    } else {
      console.warn('[Playwright] Login page but QWEN_EMAIL/PASSWORD not set.');
    }
  }

  // Wait for textarea
  console.log('[Playwright] Waiting for chat input…');
  await page
    .waitForSelector('textarea:visible, [contenteditable="true"]:visible', {
      timeout: 30000,
    })
    .catch(() => {
      throw new Error(
        `Timeout waiting for chat input. Current URL: ${page.url()}`,
      );
    });

  // Intercept
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for Qwen headers'));
    }, 60000);

    console.log('[Playwright] Setting up route interception…');
    const handler = async (route: any, request: any) => {
      clearTimeout(timeout);

      const rh = request.headers();
      let chatId = '';
      let parentId: string | null = null;

      try {
        chatId = new URL(request.url()).searchParams.get('chat_id') || '';
      } catch { /* ignore */ }

      const body = request.postData();
      if (body) {
        try {
          const p = JSON.parse(body);
          if (p.chat_id) chatId = p.chat_id;
          if (p.parent_id !== undefined) parentId = p.parent_id;
        } catch { /* ignore */ }
      }

      const headers = {
        cookie: rh['cookie'] || '',
        'bx-ua': rh['bx-ua'] || '',
        'bx-umidtoken': rh['bx-umidtoken'] || '',
        'bx-v': rh['bx-v'] || '',
        'x-request-id': rh['x-request-id'] || '',
        'user-agent': rh['user-agent'] || '',
      };

      if (!headers.cookie || !headers['bx-ua']) {
        console.log('[Playwright] Missing critical headers, skipping…');
        await route.continue();
        return;
      }

      console.log('[Playwright] Headers intercepted successfully.');
      currentHeaders = headers;
      m.cached = { headers, chatSessionId: chatId, parentMessageId: parentId };
      m.cachedAt = Date.now();
      m.lastUsedAt = Date.now();

      // Share UA/bxV for new contexts
      if (!sharedUserAgent && headers['user-agent']) sharedUserAgent = headers['user-agent'];
      if (!sharedBxV && headers['bx-v']) sharedBxV = headers['bx-v'];
      // Share full storage state (cookies + localStorage) so new contexts start fully logged in
      await saveStorageState(m.ctx);

      // Disable native tools once on first interception of this context
      if (!m.cachedAt) {
        import('./qwen.ts').then((mod) =>
          mod.disableNativeTools(headers).catch(() => {}),
        );
      }

      await route.abort('aborted');
      await page.unroute('**/api/v2/chat/completions*', handler);
      resolve(m.cached);
    };

    page.route('**/api/v2/chat/completions*', handler).then(async () => {
      const sel = 'textarea:visible, [contenteditable="true"]:visible';
      await page.focus(sel);
      await page.fill(sel, '');
      await page.type(sel, 'a', { delay: 100 });
      console.log('[Playwright] Typed char, waiting for UI update…');
      await page.waitForTimeout(2000);

      const sels = [
        '.message-input-right-button-send .send-button',
        '.chat-prompt-send-button',
        'button.send-button',
      ];
      let clicked = false;
      for (const s of sels) {
        try {
          const btn = await page.$(s);
          if (btn && (await btn.isVisible())) {
            console.log(`[Playwright] Clicking ${s}…`);
            await page.evaluate(
              (sel_) =>
                (document.querySelector(sel_) as HTMLElement)?.click(),
              s,
            );
            await btn.click({ force: true, delay: 50 }).catch(() => {});
            clicked = true;
            break;
          }
        } catch { /* try next */ }
      }

      if (!clicked) {
        console.log('[Playwright] Fallback: pressing Enter…');
        await page.focus(sel);
        await page.keyboard.press('Enter');
      }
    });
  });
}

// ──  Test helpers (only used by idle.test.ts)  ──────────────

/**
 * Return how many non-default contexts are currently in the pool.
 */
export function getContextPoolSize(): number {
  let count = 0;
  for (const key of managed.keys()) {
    if (key !== DEFAULT_KEY) count++;
  }
  return count;
}

/**
 * Forcefully mark a context's lastUsedAt for testing idle cleanup.
 */
export function __test_setContextLastUsed(key: string, timestamp: number): void {
  const s = managed.get(key);
  if (s) {
    s.lastUsedAt = timestamp;
  }
}

/**
 * Inject a fake context into the pool for testing reapIdle logic.
 */
export function __test_addMockContext(key: string): void {
  if (managed.has(key)) return;
  managed.set(key, {
    key,
    ctx: null as unknown as BrowserContext,
    page: null as unknown as Page,
    lock: Promise.resolve(),
    cached: null,
    cachedAt: 0,
    lastUsedAt: Date.now(),
  });
}

/**
 * Trigger idle cleanup directly (used by tests to avoid waiting for the real timeout).
 */
export function __test_triggerIdleCleanup(): Promise<void> {
  return reapIdle();
}

/**
 * Returns all non-default context keys currently in the pool.
 */
export function __test_getNonDefaultKeys(): string[] {
  const keys: string[] = [];
  for (const key of managed.keys()) {
    if (key !== DEFAULT_KEY) keys.push(key);
  }
  return keys;
}

/**
 * Clear all mock contexts from the pool (for test cleanup).
 */
export function __test_clearPool(): void {
  for (const key of __test_getNonDefaultKeys()) {
    managed.delete(key);
  }
}
