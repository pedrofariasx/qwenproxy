/*
 * File: playwright.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, firefox, webkit, BrowserContext, Page } from "playwright";
import path from "path";
import crypto from "crypto";
import { QwenAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";

// ─── Log Helpers ────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  redBg: "\x1b[41m",
  yellowBg: "\x1b[43m",
  greenBg: "\x1b[42m",
};

const tag = (color: string, icon: string, label: string) =>
  `${C.dim}${new Date().toLocaleTimeString("pt-BR", { hour12: false })}${C.reset} ${color}${C.bold}${icon} [${label}]${C.reset}`;

function censorEmail(email: string): string {
  return `${email.slice(0, Math.min(3, Math.max(1, email.length)))}***`;
}

const formatTags = (tags?: string[]): string => {
  if (!tags || tags.length === 0) return "";
  return " " + tags.map((t) => `${C.dim}[${t}]${C.reset}`).join(" ");
};

function pwLog(msg: string, tags?: string[], ...args: any[]) {
  console.log(
    `${tag(C.cyan, "▶", "Playwright")}${formatTags(tags)} ${msg}`,
    ...args,
  );
}
function pwSuccess(msg: string, tags?: string[], ...args: any[]) {
  console.log(
    `${tag(C.green, "✓", "Playwright")}${formatTags(tags)} ${C.green}${msg}${C.reset}`,
    ...args,
  );
}
function pwWarn(msg: string, tags?: string[], ...args: any[]) {
  console.log(
    `${tag(C.yellow, "⚠", "Playwright")}${formatTags(tags)} ${C.yellow}${msg}${C.reset}`,
    ...args,
  );
}
function pwError(msg: string, tags?: string[], ...args: any[]) {
  console.log(
    `${tag(C.red, "✗", "Playwright")}${formatTags(tags)} ${C.red}${msg}${C.reset}`,
    ...args,
  );
}
// ────────────────────────────────────────────────────────────────────────────

export type BrowserType = "chromium" | "firefox" | "webkit" | "chrome" | "edge";

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();

interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: {
    headers: Record<string, string>;
    chatSessionId: string;
    parentMessageId: string | null;
  } | null;
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
  return (
    activePage ||
    (fallbackAccountId ? (accountPages.get(fallbackAccountId) ?? null) : null)
  );
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveAccountProfilePath(accountId: string): string {
  return path.resolve(config.browser.profilesDir, accountId);
}

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
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
  if (process.env.TEST_MOCK_PLAYWRIGHT) return "token=mock";
  const page = resolvePage(accountId);
  if (!page) return "";
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export async function getBasicHeaders(
  accountId?: string,
): Promise<{ cookie: string; userAgent: string; bxV: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT)
    return { cookie: "token=mock", userAgent: "mock", bxV: "2.5.36" };

  let page = resolvePage(accountId);
  if (accountId && !page) {
    const { getAccountCredentials } = await import("../core/accounts.ts");
    const creds = getAccountCredentials(accountId);
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless);
      page = accountPages.get(accountId) ?? null;
    }
  }

  if (!page) throw new Error("Playwright not initialized");

  const cookie = await getCookies(accountId);
  const userAgent = await page.evaluate(() => navigator.userAgent);

  const cacheKey = accountId || "global";
  const cache = getAccountHeaderCache(cacheKey);
  const bxV = cache.currentHeaders["bx-v"] || "2.5.36";

  return { cookie, userAgent, bxV };
}

export async function initPlaywright(
  headless = true,
  browserType: BrowserType = "chromium",
) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve(config.browser.userDataDir);

  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case "firefox":
      browserEngine = firefox;
      break;
    case "webkit":
      browserEngine = webkit;
      break;
    case "chrome":
      browserEngine = chromium;
      channel = "chrome";
      break;
    case "edge":
      browserEngine = chromium;
      channel = "msedge";
      break;
    case "chromium":
    default:
      browserEngine = chromium;
      break;
  }

  pwLog(`Launching ${browserType}...`);

  context = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  activePage = await context.newPage();

  const { loadAccounts } = await import("../core/accounts.ts");
  const accounts = loadAccounts();
  const hasCredentials = accounts.length > 0;
  const hasValidSession = await checkValidSession();

  if (!hasValidSession && !hasCredentials) {
    pwWarn(
      "No valid session AND no credentials configured. Manual login will be required.",
    );
  }

  if (!hasValidSession) {
    await attemptAutoLogin();
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const cookies = await activePage.context().cookies();
    const hasAuthCookie = cookies.some(
      (c) =>
        c.name.toLowerCase().includes("token") ||
        c.name.toLowerCase().includes("session"),
    );
    if (!hasAuthCookie) return false;
    await activePage.goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    const isLogged =
      !activePage.url().includes("auth") && !activePage.url().includes("login");
    return isLogged;
  } catch {
    return false;
  }
}

async function attemptAutoLogin(): Promise<void> {
  const { loadAccounts } = await import("../core/accounts.ts");
  const accounts = loadAccounts();
  if (accounts.length === 0) return;
  const { email, password } = accounts[0];
  pwLog("Attempting auto-login with configured credentials...");
  try {
    const success = await loginToQwen(email, password);
    if (success) {
      pwSuccess("Auto-login successful.");
      return;
    }
    pwWarn("API login failed, trying UI fallback...");
    const uiSuccess = await loginToQwenUI(email, password);
    if (uiSuccess) {
      pwSuccess("UI login fallback successful.");
    } else {
      pwWarn("Both API and UI login failed. Manual login may be required.");
    }
  } catch (err: any) {
    pwError("Auto-login error:", err.message);
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

export async function loginToQwen(
  email: string,
  password: string,
): Promise<boolean> {
  if (!activePage) throw new Error("Playwright not initialized");

  pwLog(`Attempting API login for ${censorEmail(email)}...`, ["auth", "api"]);

  await activePage.goto("https://chat.qwen.ai/auth", {
    waitUntil: "domcontentloaded",
  });

  const hashedPassword = crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");

  const result = await activePage.evaluate(
    async ({ email, password }) => {
      try {
        const response = await fetch(
          "https://chat.qwen.ai/api/v2/auths/signin",
          {
            method: "POST",
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json",
              source: "web",
              timezone: new Date().toString().split(" (")[0],
              "x-request-id": crypto.randomUUID(),
            },
            body: JSON.stringify({ email, password, login_type: "email" }),
          },
        );
        const data = await response.json();
        return { ok: response.ok, data };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
    { email, password: hashedPassword },
  );

  if (result.ok) {
    pwSuccess("API login request successful.");
    await activePage.goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
    });
    const isLogged = !(
      activePage.url().includes("auth") || activePage.url().includes("login")
    );
    if (isLogged) {
      pwSuccess("Login confirmed.");
      return true;
    }
  }

  pwError("Login failed:", result.data || result.error);
  return false;
}

async function loginToQwenUI(
  email: string,
  password: string,
): Promise<boolean> {
  if (!activePage) throw new Error("Playwright not initialized");

  pwLog("Attempting UI login...");
  await activePage.goto("https://chat.qwen.ai/auth", {
    waitUntil: "domcontentloaded",
  });
  await sleep(2000);

  if (!activePage.url().includes("/auth")) {
    pwSuccess("Already logged in");
    return true;
  }

  try {
    await activePage.waitForSelector(
      'input[type="email"], input[placeholder*="Email"]',
      { timeout: 5000 },
    );
  } catch {
    if (activePage.url().includes("/auth"))
      throw new Error("Email input not found");
    pwSuccess("Already logged in");
    return true;
  }

  pwLog("UI: Filling email...");
  await activePage.fill(
    'input[type="email"], input[placeholder*="Email"]',
    email,
  );
  await activePage.keyboard.press("Enter");
  await sleep(1000);

  await activePage.waitForSelector('input[type="password"]', {
    timeout: 10000,
  });
  pwLog("UI: Filling password...");
  await activePage.fill('input[type="password"]', password);
  await activePage.keyboard.press("Enter");

  await sleep(2000);

  const isLogged =
    !activePage.url().includes("auth") && !activePage.url().includes("login");
  if (isLogged) {
    pwSuccess("UI login OK");
    return true;
  }

  pwWarn("UI login failed");
  return false;
}

export async function getQwenHeaders(
  forceNew = false,
  accountId?: string,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  const cacheKey = accountId || "global";
  const cache = getAccountHeaderCache(cacheKey);

  if (
    !forceNew &&
    cache.cachedQwenHeaders &&
    Date.now() - cache.lastHeadersTime < HEADERS_TTL * REFRESH_THRESHOLD
  ) {
    return cache.cachedQwenHeaders;
  }
  const release = await uiMutex.acquire();
  try {
    if (
      !forceNew &&
      cache.cachedQwenHeaders &&
      Date.now() - cache.lastHeadersTime < HEADERS_TTL
    ) {
      release();
      return cache.cachedQwenHeaders;
    }
    return await _getQwenHeadersInternal(forceNew, accountId);
  } finally {
    release();
  }
}

async function _getQwenHeadersInternal(
  forceNew = false,
  accountId?: string,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  const cacheKey = accountId || "global";
  const cache = getAccountHeaderCache(cacheKey);

  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || "mock-session";
    return {
      headers: {
        authorization: "Bearer MOCK",
        cookie: "token=mock",
        "user-agent": "mock",
        "bx-v": "2.5.36",
      },
      chatSessionId: mockSessionId,
      parentMessageId: null,
    };
  }

  if (
    !forceNew &&
    cache.cachedQwenHeaders &&
    Date.now() - cache.lastHeadersTime < HEADERS_TTL
  ) {
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
    const { getAccountCredentials } = await import("../core/accounts.ts");
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
  const isOnQwen = currentUrl.includes("chat.qwen.ai");
  const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

  if (!isOnQwen || forceNew || isOnSpecificChat) {
    pwLog(
      `Navigating to Qwen home for ${cacheKey}... (Current: ${currentUrl})`,
    );
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded" });
  }

  const isLoginPage =
    page.url().includes("login") ||
    (await page.$('input[type="email"], input[placeholder*="Email"]'));
  if (isLoginPage) {
    const { loadAccounts } = await import("../core/accounts.ts");
    const accounts = loadAccounts();
    const targetAccount = accountId
      ? accounts.find((a) => a.id === accountId)
      : accounts[0];

    if (targetAccount && targetAccount.email && targetAccount.password) {
      pwLog(
        `Detected login page. Attempting login for ${censorEmail(targetAccount.email)}...`,
        ["auth", "login-page"],
      );
      try {
        if (accountId) {
          const acctContext = accountContexts.get(accountId);
          if (acctContext) {
            await loginToQwenWithContext(
              acctContext,
              page,
              targetAccount.email,
              targetAccount.password,
            );
          }
        } else {
          const loggedIn = await loginToQwen(
            targetAccount.email,
            targetAccount.password,
          );
          if (!loggedIn) {
            throw new Error("loginToQwen returned false");
          }
          pwSuccess("Automated login successful.");
        }
      } catch (err: any) {
        pwError("Automated login failed:", err.message);
      }
    } else {
      pwWarn("Detected login page but no credentials configured");
    }
  }

  pwLog(`Waiting for chat input for ${cacheKey}...`);
  const playwrightInputSelector =
    'textarea:visible, [contenteditable="true"]:visible';
  await page
    .waitForSelector(playwrightInputSelector, { timeout: 30000 })
    .catch(() => {
      pwError(`Chat input not found for ${cacheKey}. Current URL:`, undefined, page.url());
      throw new Error(
        `Timeout waiting for chat input for ${cacheKey}. Are you logged in?`,
      );
    });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      pwError(
        `Timeout (90s) waiting for Qwen headers for ${cacheKey}. Current URL:`,
        undefined,
        page.url(),
      );
      try {
        const screenshotPath = path.resolve(
          config.browser.profilesDir,
          `error_${cacheKey}.png`,
        );
        await page.screenshot({ path: screenshotPath });
        pwLog(`Error screenshot saved to ${screenshotPath}`);
      } catch (err: any) {
        pwError("Failed to save error screenshot:", err.message);
      }
      reject(new Error(`Timeout waiting for Qwen headers for ${cacheKey}`));
    }, 90000);

    let requestFired = false;
    const markFired = () => {
      requestFired = true;
    };

    pwLog(`Setting up route interception for ${cacheKey}...`);
    const routeHandler = async (route: any, request: any) => {
      markFired();
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      let uiSessionId = "";
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
        } catch (e) {}
      }

      const extractedHeaders = {
        cookie: reqHeaders["cookie"] || "",
        "bx-ua": reqHeaders["bx-ua"] || "",
        "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
        "bx-v": reqHeaders["bx-v"] || "",
        "x-request-id": reqHeaders["x-request-id"] || "",
        "user-agent": reqHeaders["user-agent"] || "",
      };

      if (!extractedHeaders.cookie || !extractedHeaders["bx-ua"]) {
        pwWarn(
          `Intercepted request missing critical headers for ${cacheKey}, skipping...`,
        );
        await route.continue();
        return;
      }

      pwSuccess(`Successfully intercepted headers for ${cacheKey}.`);
      cache.currentHeaders = extractedHeaders;
      cache.cachedQwenHeaders = {
        headers: extractedHeaders,
        chatSessionId: uiSessionId,
        parentMessageId: uiParentMessageId,
      };
      cache.lastHeadersTime = Date.now();
      if (cache.refreshTimeout) {
        clearTimeout(cache.refreshTimeout);
        cache.refreshTimeout = null;
      }

      import("./qwen.ts").then((m) =>
        m.disableNativeTools(accountId).catch(() => {}),
      );

      await route.abort("aborted");

      await page.unroute("**/api/v2/chat/completions*", routeHandler);

      resolve(cache.cachedQwenHeaders);
    };

    page.route("**/api/v2/chat/completions*", routeHandler).then(async () => {
      pwLog(`Triggering request for ${cacheKey}...`);
      const playwrightInputSelector =
        'textarea:visible, [contenteditable="true"]:visible';
      const domInputSelector = 'textarea, [contenteditable="true"]';

      await page.fill(playwrightInputSelector, "");
      await page.type(playwrightInputSelector, "a", { delay: 100 });
      await sleep(1500);

      const sendButtonSelectors = [
        ".message-input-right-button-send .send-button",
        ".chat-prompt-send-button",
        "button.send-button",
        '[data-testid="send-button"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="Send" i]',
      ];

      const findSendButton = async (): Promise<string | null> => {
        for (const sel of sendButtonSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn && (await btn.isVisible())) {
              const isDisabled = await btn.evaluate((el: HTMLElement) => {
                return (
                  (el as HTMLButtonElement).disabled ||
                  el.getAttribute("aria-disabled") === "true" ||
                  el.classList.contains("disabled")
                );
              });
              if (!isDisabled) return sel;
            }
          } catch {}
        }
        return null;
      };

      const trySend = async (): Promise<boolean> => {
        const btnSel = await findSendButton();
        if (btnSel) {
          pwLog(`Found send button: ${btnSel}`);
          try {
            await page.click(btnSel, { force: true, timeout: 3000 });
            await sleep(1000);
            if (requestFired) return true;
          } catch {}
          try {
            await page.evaluate((sel: string) => {
              const el = document.querySelector(sel) as HTMLElement;
              if (el) {
                el.focus();
                el.click();
              }
            }, btnSel);
            await sleep(1000);
            if (requestFired) return true;
          } catch {}
        }

        pwLog("Trying Enter key...");
        await page.focus(playwrightInputSelector);
        await page.keyboard.press("Enter");
        await sleep(1500);
        if (requestFired) return true;

        pwLog("Trying Shift+Enter then Enter...");
        await page.focus(playwrightInputSelector);
        await page.keyboard.press("Shift+Enter");
        await sleep(300);
        await page.keyboard.press("Enter");
        await sleep(1500);
        if (requestFired) return true;

        return false;
      };

      let sent = await trySend();

      if (!sent) {
        pwWarn(`First attempt failed, re-typing and retrying...`);
        await page.fill(playwrightInputSelector, "");
        await page.type(playwrightInputSelector, "Test a", { delay: 80 });
        await sleep(1000);
        sent = await trySend();
      }

      if (!sent) {
        pwWarn(`Second attempt failed, trying dispatchEvent approach...`);
        await page.fill(playwrightInputSelector, "a");
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, domInputSelector);
        await sleep(500);

        const btnSel = await findSendButton();
        if (btnSel) {
          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) {
              el.dispatchEvent(
                new MouseEvent("click", { bubbles: true, cancelable: true }),
              );
            }
          }, btnSel);
          await sleep(2000);
        }

        if (!requestFired) {
          await page.focus(playwrightInputSelector);
          await page.keyboard.press("Enter");
          await sleep(2000);
        }
      }

      if (!requestFired) {
        pwWarn(
          `All send attempts failed for ${cacheKey}. Request may not have been triggered.`,
        );
      }
    });
  });
}

export async function initPlaywrightForAccount(
  account: QwenAccount,
  headless = true,
  browserType: BrowserType = "chromium",
) {
  const profilePath = resolveAccountProfilePath(account.id);

  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case "firefox":
      browserEngine = firefox;
      break;
    case "webkit":
      browserEngine = webkit;
      break;
    case "chrome":
      browserEngine = chromium;
      channel = "chrome";
      break;
    case "edge":
      browserEngine = chromium;
      channel = "msedge";
      break;
    case "chromium":
    default:
      browserEngine = chromium;
      break;
  }

  pwLog(
    `Launching ${browserType} for account ${censorEmail(account.email)}...`,
    ["launch", "account"],
  );

  const acctContext = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);

  const cookies = await acctContext.cookies();
  const hasAuthCookie = cookies.some(
    (c) =>
      c.name.toLowerCase().includes("token") ||
      c.name.toLowerCase().includes("session"),
  );

  if (!hasAuthCookie && account.email && account.password) {
    await loginToQwenWithContext(
      acctContext,
      acctPage,
      account.email,
      account.password,
    );
  }
}

export async function launchManualLoginAccount(
  accountId: string,
  browserType: BrowserType = "chromium",
): Promise<{ context: BrowserContext; page: Page }> {
  const profilePath = resolveAccountProfilePath(accountId);

  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case "firefox":
      browserEngine = firefox;
      break;
    case "webkit":
      browserEngine = webkit;
      break;
    case "chrome":
      browserEngine = chromium;
      channel = "chrome";
      break;
    case "edge":
      browserEngine = chromium;
      channel = "msedge";
      break;
    case "chromium":
    default:
      browserEngine = chromium;
      break;
  }

  const acctContext = await browserEngine.launchPersistentContext(profilePath, {
    headless: false,
    channel,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const acctPage = await acctContext.newPage();
  await acctPage.goto("https://chat.qwen.ai/auth", {
    waitUntil: "domcontentloaded",
  });

  return { context: acctContext, page: acctPage };
}

export async function extractAccountInfoFromContext(
  page: Page,
): Promise<{ email: string | null; hasSession: boolean }> {
  const cookies = await page.context().cookies();
  const hasSession = cookies.some(
    (c) =>
      c.name.toLowerCase().includes("token") ||
      c.name.toLowerCase().includes("session"),
  );

  let email: string | null = null;
  if (hasSession) {
    try {
      email = await page.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="user-email"], .user-email, [class*="email"]',
        );
        return el?.textContent?.trim() || null;
      });
    } catch {}
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

async function loginToQwenWithContext(
  acctContext: BrowserContext,
  acctPage: Page,
  email: string,
  password: string,
): Promise<boolean> {
  await acctPage.goto("https://chat.qwen.ai/auth", {
    waitUntil: "domcontentloaded",
  });

  const hashedPassword = crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");

  const result = await acctPage.evaluate(
    async ({ email, password }) => {
      try {
        const response = await fetch(
          "https://chat.qwen.ai/api/v2/auths/signin",
          {
            method: "POST",
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json",
              source: "web",
              timezone: new Date().toString().split(" (")[0],
              "x-request-id": crypto.randomUUID(),
            },
            body: JSON.stringify({ email, password, login_type: "email" }),
          },
        );
        const data = await response.json();
        return { ok: response.ok, data };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    },
    { email, password: hashedPassword },
  );

  if (result.ok) {
    await acctPage.goto("https://chat.qwen.ai/", {
      waitUntil: "domcontentloaded",
    });
    const isLogged = !(
      acctPage.url().includes("auth") || acctPage.url().includes("login")
    );
    if (isLogged) {
      pwSuccess(`Login confirmed for ${censorEmail(email)}.`, [
        "auth",
        "success",
      ]);
      return true;
    }
  }

  pwError(
    `Login failed for ${censorEmail(email)}:`,
    ["auth", "error"],
    result.data || result.error,
  );
  return false;
}
