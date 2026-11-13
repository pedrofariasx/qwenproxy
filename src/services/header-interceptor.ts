import type { Page } from "patchright";
import { config } from "../core/config.js";
import { QWEN_BX_VERSION_FALLBACK } from "../utils/qwen-constants.js";
import { getBxVersion, refreshQwenVersions } from "./qwen-versions.js";
import { applyBearerToken, renewAccessToken } from "./access-token-manager.js";
import { hasExpiredBearerToken } from "../utils/access-token.js";
import {
  getActiveAccountCount,
  markAccountReady,
} from "../core/account-manager.js";
import { getBaseAccountId } from "../core/account-lanes.js";
import {
  CHROME_UA,
  COOKIE_CACHE_TTL,
  REFRESH_THRESHOLD,
  GUEST_HEADERS_TTL,
  getHeadersTtlMs,
  getBackgroundHeaderRefresh,
  sleep,
  accountContexts,
  accountPages,
  cachedUserAgents,
  cookieCaches,
  getAccountHeaderCache,
  getActivePage,
  getGuestPage,
  getGuestHeadersCache,
  setGuestHeadersCache,
  setGuestContext,
  setGuestPage,
  getOrLaunchBrowser,
  loadStorageState,
  sharedContextOptions,
  getUiMutex,
  resetBrowserProfile,
  initPlaywright,
  initPlaywrightForAccount,
  dismissAgeModal,
} from "./browser-manager.js";
import { getStealthScript } from "./stealth.js";
import { startCaptchaWatcher } from "./captcha-solver.js";
import { humanType, humanDelay } from "./human-behavior.js";
import { getFingerprintProfile } from "./fingerprint.js";

export async function getCookies(accountId?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return "token=mock";
  const cacheKey = accountId || "global";
  const now = Date.now();
  const cached = cookieCaches.get(cacheKey);
  if (cached && now - cached.timestamp < COOKIE_CACHE_TTL) {
    return cached.cookie;
  }
  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) return "";
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  cookieCaches.set(cacheKey, { cookie: cookieStr, timestamp: now });
  return cookieStr;
}

export async function extractAntiBotTokensFromPage(
  page: Page,
): Promise<{ bxUa: string; bxUmidtoken: string; authorization?: string }> {
  try {
    return await page.evaluate(
      async () => {
        const w = window as any;
        let bxUa = "";
        try {
          if (w.AWSC && w.AWSC.use) {
            bxUa = await new Promise((resolve) => {
              w.AWSC.use("fy", (state: any, module: any) => {
                if (state === "loaded" && module?.getFYToken) {
                  resolve(module.getFYToken() || "");
                } else {
                  resolve("");
                }
              });
              setTimeout(() => resolve(""), 3000);
            });
          }
        } catch {
          /* ignore */
        }

        let bxUmidtoken = "";
        try {
          if (w.__awsc_et__?.getETToken) {
            bxUmidtoken = w.__awsc_et__.getETToken() || "";
          }
        } catch {
          /* ignore */
        }

        if (!bxUmidtoken) {
          try {
            if (w.AWSC && w.AWSC.use) {
              bxUmidtoken = await new Promise((resolve) => {
                w.AWSC.use("umid", (state: any, module: any) => {
                  if (state === "loaded" && module?.getSecurityToken) {
                    resolve(module.getSecurityToken() || "");
                  } else {
                    resolve("");
                  }
                });
                setTimeout(() => resolve(""), 2000);
              });
            }
          } catch {
            /* ignore */
          }
        }

        // Try to find authorization Bearer token in localStorage
        let authorization = "";
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            const val = localStorage.getItem(key) || "";
            if (
              key.toLowerCase().includes("token") ||
              key.toLowerCase().includes("access")
            ) {
              if (val.startsWith("eyJ") || val.startsWith("Bearer ")) {
                authorization = val.startsWith("Bearer ")
                  ? val
                  : `Bearer ${val}`;
                break;
              }
            }
          }
        } catch {
          /* ignore */
        }

        return { bxUa, bxUmidtoken, authorization };
      },
      { world: "main" },
    );
  } catch {
    return { bxUa: "", bxUmidtoken: "", authorization: "" };
  }
}

export async function getBasicHeaders(accountId?: string): Promise<{
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa?: string;
  bxUmidtoken?: string;
  authorization?: string;
}> {
  if (process.env.TEST_MOCK_PLAYWRIGHT)
    return {
      cookie: "token=mock",
      userAgent: "mock",
      bxV: QWEN_BX_VERSION_FALLBACK,
      bxUa: "mock-bx-ua",
      bxUmidtoken: "mock-bx-umidtoken",
      authorization: "Bearer mock",
    };

  let page = accountId ? accountPages.get(accountId) : getActivePage();
  if (accountId && !page) {
    const { getAccountCredentials } = await import("../core/accounts.js");
    const creds = getAccountCredentials(getBaseAccountId(accountId));
    if (creds) {
      await initPlaywrightForAccount(
        { ...creds, id: accountId },
        config.browser.headless,
      );
      page = accountPages.get(accountId);
    }
  }

  if (!page) throw new Error("Playwright not initialized");

  const cookie = await getCookies(accountId);
  const cacheKey = accountId || "global";

  let userAgent = cachedUserAgents.get(cacheKey);
  if (!userAgent) {
    userAgent = await page.evaluate(() => navigator.userAgent);
    cachedUserAgents.set(cacheKey, userAgent);
  }

  const cache = getAccountHeaderCache(cacheKey);
  let bxUa = cache.currentHeaders["bx-ua"];
  let bxUmidtoken = cache.currentHeaders["bx-umidtoken"];
  let authorization: string | undefined = cache.currentHeaders["authorization"];
  const bxV = cache.currentHeaders["bx-v"] || getBxVersion();

  // A cached access token expires after 15 minutes. Renew it up-front so
  // callers never receive headers that upstream would reject.
  if (authorization && hasExpiredBearerToken({ authorization })) {
    const renewed = await renewAccessToken(accountId, page);
    if (renewed) {
      authorization = renewed;
      cache.currentHeaders["authorization"] = renewed;
    } else {
      authorization = undefined;
    }
  }

  if (!bxUa || !bxUmidtoken || !authorization) {
    // Fast path: extract directly from AWSC and __awsc_et__ on the page
    const direct = await extractAntiBotTokensFromPage(page);
    if (direct.bxUa && direct.bxUmidtoken && direct.authorization) {
      bxUa = direct.bxUa;
      bxUmidtoken = direct.bxUmidtoken;
      authorization = direct.authorization;
      cache.currentHeaders["bx-ua"] = bxUa;
      cache.currentHeaders["bx-umidtoken"] = bxUmidtoken;
      cache.currentHeaders["authorization"] = authorization;
      cache.currentHeaders["bx-v"] = getBxVersion();
      markAccountReady(cacheKey);
      return {
        cookie: await getCookies(accountId),
        userAgent,
        bxV: getBxVersion(),
        bxUa,
        bxUmidtoken,
        authorization,
      };
    }

    console.log(
      `[Playwright] Missing bx-ua/bx-umidtoken for ${cacheKey}, triggering header interception...`,
    );
    try {
      const result = await getQwenHeaders(true, accountId);
      bxUa = result.headers["bx-ua"];
      bxUmidtoken = result.headers["bx-umidtoken"];
      authorization = result.headers["authorization"] || authorization;
      markAccountReady(cacheKey);
      return {
        cookie: await getCookies(accountId),
        userAgent,
        bxV: result.headers["bx-v"] || bxV,
        bxUa,
        bxUmidtoken,
        authorization,
      };
    } catch (err: any) {
      console.warn(
        `[Playwright] Failed to auto-recover headers for ${cacheKey}: ${err.message}`,
      );
    }
  }

  if (bxUa && bxUmidtoken && authorization) {
    markAccountReady(cacheKey);
  }

  return { cookie, userAgent, bxV, bxUa, bxUmidtoken, authorization };
}

export async function getGuestHeaders(): Promise<Record<string, string>> {
  const cached = getGuestHeadersCache();
  if (cached && Date.now() - cached.timestamp < GUEST_HEADERS_TTL) {
    return cached.headers;
  }

  let guestPage = getGuestPage();
  if (!guestPage) {
    const sharedBrowser = await getOrLaunchBrowser("chromium");
    const storageState = loadStorageState("_guest");
    const guestProfile = getFingerprintProfile("_guest");
    const guestCtx = await sharedBrowser.newContext({
      ...sharedContextOptions("_guest"),
      ...(storageState ? { storageState } : {}),
    });
    await guestCtx.addInitScript(getStealthScript(guestProfile));
    setGuestContext(guestCtx);
    guestPage = await guestCtx.newPage();
    setGuestPage(guestPage);

    await guestPage.goto("https://chat.qwen.ai/c/guest", {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigation,
    });

    try {
      const keepSessionBtn = await guestPage.$(
        'button:has-text("Manter sessão terminada"), button:has-text("Keep session ended"), button:has-text("Manter sessão encerrada")',
      );
      if (keepSessionBtn) {
        await keepSessionBtn.click();
        console.log('[Playwright] Guest: Clicked "Manter sessão terminada"');
        await sleep(1000);
      }
    } catch {
      /* ignore popup errors */
    }
  }

  const watcher = startCaptchaWatcher(guestPage!, config.timeouts.headers);
  try {
    return await new Promise<Record<string, string>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resetBrowserProfile("guest", "guest")
          .catch((err: any) =>
            console.warn(
              `[Playwright] Failed to reset guest profile after timeout: ${err.message}`,
            ),
          )
          .finally(() => reject(new Error("Timeout getting guest headers")));
      }, config.timeouts.headers);

      const routeHandler = async (route: any, request: any) => {
        clearTimeout(timeout);
        const reqHeaders = request.headers();
        console.log("[Playwright] Guest intercepted request:", request.url());

        const extractedHeaders = {
          cookie: reqHeaders["cookie"] || "",
          "bx-ua": reqHeaders["bx-ua"] || "",
          "bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
          "bx-v": reqHeaders["bx-v"] || getBxVersion(),
          "user-agent": reqHeaders["user-agent"] || CHROME_UA,
        };

        if (extractedHeaders["bx-ua"]) {
          console.log("[Playwright] Guest: Successfully captured bx-ua");
          setGuestHeadersCache({
            headers: extractedHeaders,
            timestamp: Date.now(),
          });
          await route.abort("aborted").catch(() => {});
          await guestPage!
            .unroute("**/api/v2/chat/completions*", routeHandler)
            .catch(() => {});

          import("./qwen.js").then((m) =>
            m.disableNativeTools("guest").catch(() => {}),
          );

          resolve(extractedHeaders);
        } else {
          console.log(
            "[Playwright] Guest: Request missing bx-ua, continuing route. Headers:",
            Object.keys(reqHeaders),
          );
          await route.continue().catch(() => {});
          if (request.url().includes("/api/v2/chat/completions")) {
            await guestPage!
              .unroute("**/api/v2/chat/completions*", routeHandler)
              .catch(() => {});
            reject(
              new Error(
                "Guest completions request was missing bx-ua; refusing to cache inconsistent anti-bot headers.",
              ),
            );
          }
        }
      };

      guestPage!
        .route("**/api/v2/chat/completions*", routeHandler)
        .then(async () => {
          const inputSelector =
            'textarea:visible, [contenteditable="true"]:visible';
          try {
            await guestPage!.waitForSelector(inputSelector, {
              timeout: config.timeouts.page,
            });
            await humanType(guestPage!, inputSelector, "Hello");
            await sleep(humanDelay(800, 1500));

            const selectors = [
              ".message-input-right-button-send .send-button",
              ".chat-prompt-send-button",
              "button.send-button",
            ];
            let clicked = false;
            for (const selector of selectors) {
              const btn = await guestPage!.$(selector);
              if (btn && (await btn.isVisible())) {
                await btn.click({ force: true, delay: 50 }).catch(() => {});
                clicked = true;
                break;
              }
            }
            if (!clicked) {
              await guestPage!.keyboard.press("Enter");
            }
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
        });
    });
  } finally {
    watcher.stop();
  }
}

export async function getQwenHeaders(
  forceNew = false,
  accountId?: string,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  if (accountId === "guest") {
    const headers = await getGuestHeaders();
    return { headers, chatSessionId: "guest-session", parentMessageId: null };
  }

  const cacheKey = accountId || "global";
  const cache = getAccountHeaderCache(cacheKey);

  if (!forceNew && cache.cachedQwenHeaders) {
    // A cached access token expires after 15 minutes, well before the header
    // cache TTL. Renew it instead of serving a token that no longer works.
    if (hasExpiredBearerToken(cache.cachedQwenHeaders.headers)) {
      const renewed = await renewAccessToken(accountId);
      if (renewed) {
        cache.cachedQwenHeaders = {
          ...cache.cachedQwenHeaders,
          headers: applyBearerToken(cache.cachedQwenHeaders.headers, renewed),
        };
        cache.currentHeaders["authorization"] = renewed;
        return cache.cachedQwenHeaders;
      }
      // Renewal failed: fall through to a full header capture.
      forceNew = true;
    } else {
      const age = Date.now() - cache.lastHeadersTime;
      if (age < getHeadersTtlMs()) {
        if (
          getBackgroundHeaderRefresh() &&
          age > getHeadersTtlMs() * REFRESH_THRESHOLD &&
          !cache.refreshInProgress
        ) {
          cache.refreshInProgress = true;
          getQwenHeaders(true, accountId)
            .catch((err) => {
              console.warn(
                `[Playwright] Background header refresh failed for ${cacheKey}: ${(err as Error).message}`,
              );
            })
            .finally(() => {
              cache.refreshInProgress = false;
            });
        }
        return cache.cachedQwenHeaders;
      }
    }
  }

  const release = await getUiMutex(cacheKey).acquire();
  try {
    if (
      !forceNew &&
      cache.cachedQwenHeaders &&
      Date.now() - cache.lastHeadersTime < getHeadersTtlMs()
    ) {
      return cache.cachedQwenHeaders;
    }
    return await _getQwenHeadersInternal(forceNew, accountId);
  } finally {
    release();
  }
}

async function tryLightweightCookieRefresh(accountId?: string): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
} | null> {
  const cacheKey = accountId || "global";
  const cache = getAccountHeaderCache(cacheKey);

  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) return null;

  try {
    const cookies = await page.context().cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
        "user-agent": userAgent,
      };
      cache.cachedQwenHeaders = {
        ...cache.cachedQwenHeaders,
        headers: updatedHeaders,
      };
      cache.lastHeadersTime = now;
      cache.currentHeaders = {
        ...cache.currentHeaders,
        cookie: cookieStr,
        "user-agent": userAgent,
      };
      return cache.cachedQwenHeaders;
    }
  } catch {
    /* ignore cache read errors */
  }

  return null;
}

const MAX_HEADER_CAPTURE_RETRIES = 2;

async function _getQwenHeadersInternal(
  forceNew = false,
  accountId?: string,
): Promise<{
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: string | null;
}> {
  const cacheKey = accountId || "global";
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_HEADER_CAPTURE_RETRIES; attempt++) {
    try {
      return await _getQwenHeadersInternalOnce(
        forceNew || attempt > 0,
        accountId,
      );
    } catch (err: any) {
      lastError = err;
      const isTimeout = err?.message?.includes(
        "Timeout waiting for Qwen headers for",
      );

      if (attempt < MAX_HEADER_CAPTURE_RETRIES && isTimeout) {
        console.warn(
          `[Playwright] Header capture timed out for ${cacheKey}; clearing browser profile and retrying (attempt ${attempt + 1}/${MAX_HEADER_CAPTURE_RETRIES})...`,
        );
        await resetBrowserProfile(cacheKey, accountId);
        if (!accountId && getActiveAccountCount() === 0) {
          await initPlaywright(config.browser.headless, config.browser.type);
        }
        continue;
      }

      break;
    }
  }

  throw (
    lastError ||
    new Error(
      `Header capture failed for ${cacheKey} after ${MAX_HEADER_CAPTURE_RETRIES + 1} attempts`,
    )
  );
}

async function _getQwenHeadersInternalOnce(
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
        "bx-v": getBxVersion(),
        "bx-ua": "mock-bx-ua",
        "bx-umidtoken": "mock-bx-umidtoken",
      },
      chatSessionId: mockSessionId,
      parentMessageId: null,
    };
  }

  if (!forceNew && cache.cachedQwenHeaders) {
    const lightResult = await tryLightweightCookieRefresh(accountId);
    if (lightResult) {
      return lightResult;
    }
  }

  if (accountId && !accountPages.has(accountId)) {
    const { getAccountCredentials } = await import("../core/accounts.js");
    const creds = getAccountCredentials(getBaseAccountId(accountId));
    if (creds) {
      await initPlaywrightForAccount(
        { ...creds, id: accountId },
        config.browser.headless,
      );
    }
  }

  const page = accountId ? accountPages.get(accountId) : getActivePage();
  if (!page) {
    throw new Error(`Playwright not initialized for account: ${cacheKey}`);
  }

  const currentUrl = page.url();
  const isOnNewChat = /\/c\//.test(currentUrl);

  if (!isOnNewChat) {
    console.log(
      `[Playwright] Navigating to stable Qwen new-chat page for ${cacheKey}... (Current: ${currentUrl})`,
    );
    try {
      await page.goto("https://chat.qwen.ai/c/new-chat", {
        waitUntil: "domcontentloaded",
        timeout: config.timeouts.navigation,
      });
      await dismissAgeModal(page);
      await sleep(1500);
    } catch (err: any) {
      console.warn(
        `[Playwright] Warning navigating to new-chat: ${err.message}`,
      );
    }
  }

  // Keep the `version` and `bx-v` headers aligned with the live deployment.
  await refreshQwenVersions(page).catch(() => undefined);

  const isLoginPage =
    page.url().includes("login") ||
    page.url().includes("auth") ||
    (await page.$('input[name="email"], input[type="email"]'));
  if (isLoginPage) {
    if (!accountId) {
      const email = process.env.QWEN_EMAIL;
      const password = process.env.QWEN_PASSWORD;

      if (email && password) {
        console.log(
          "[Playwright] Detected login page. Attempting automated login...",
        );
        try {
          const { loginToQwen } = await import("./browser-manager.js");
          const loggedIn = await loginToQwen(email, password);
          if (!loggedIn) {
            throw new Error("loginToQwen returned false");
          }
          console.log("[Playwright] Automated login successful.");
        } catch (err: any) {
          console.error("[Playwright] Automated login failed:", err.message);
        }
      } else {
        console.warn(
          "[Playwright] Detected login page but QWEN_EMAIL/PASSWORD not provided in .env",
        );
      }
    } else {
      const { getAccountCredentials } = await import("../core/accounts.js");
      const creds = getAccountCredentials(getBaseAccountId(accountId));
      if (creds && creds.email && creds.password) {
        console.log(
          `[Playwright] Detected login page for account ${creds.email}. Attempting login...`,
        );
        const acctContext = accountContexts.get(accountId);
        if (acctContext) {
          const pageForLogin = accountPages.get(accountId);
          if (pageForLogin) {
            const { loginToQwenWithContext, saveStorageState } =
              await import("./browser-manager.js");
            const ok = await loginToQwenWithContext(
              acctContext,
              pageForLogin,
              creds.email,
              creds.password,
            );
            if (ok) {
              await saveStorageState(acctContext, getBaseAccountId(accountId));
              await pageForLogin
                .goto("https://chat.qwen.ai/c/new-chat", {
                  waitUntil: "domcontentloaded",
                })
                .catch(() => {});
            }
          }
        }
      }
    }
  }

  // The Bearer token is issued by auth.qwen.ai/api/v2/auths/refresh, which
  // requires the refresh_token cookie set during signin. A cached token that
  // already expired must be renewed, otherwise upstream rejects every call
  // with a generic "Unauthorized" error.
  const cachedAuthorization = cache.currentHeaders["authorization"];
  let accessToken: string | null = cachedAuthorization
    ? cachedAuthorization.replace(/^Bearer\s+/i, "")
    : null;

  if (
    accessToken &&
    hasExpiredBearerToken({ authorization: cachedAuthorization })
  ) {
    accessToken = null;
  }

  if (!accessToken) {
    const { refreshQwenAccessToken, renewAccessTokenViaPage } =
      await import("./browser-manager.js");
    accessToken = await refreshQwenAccessToken(page);
    if (!accessToken) {
      // The refresh endpoint only accepts requests issued by the real web
      // client, so let the frontend perform the refresh by reloading.
      accessToken = await renewAccessTokenViaPage(page);
    }
    if (accessToken) {
      console.log(`[Playwright] Refreshed Qwen access token for ${cacheKey}.`);
    } else {
      console.warn(
        `[Playwright] Could not refresh Qwen access token for ${cacheKey}.`,
      );
    }
  }

  const directTokens = await extractAntiBotTokensFromPage(page);
  if (directTokens.bxUa && directTokens.bxUmidtoken) {
    const cookies = await getCookies(accountId);
    let userAgent = cachedUserAgents.get(cacheKey);
    if (!userAgent) {
      userAgent = await page.evaluate(() => navigator.userAgent);
      cachedUserAgents.set(cacheKey, userAgent);
    }
    const authorization = accessToken ? `Bearer ${accessToken}` : "";
    const extractedHeaders = {
      cookie: cookies,
      "bx-ua": directTokens.bxUa,
      "bx-umidtoken": directTokens.bxUmidtoken,
      "bx-v": getBxVersion(),
      "user-agent": userAgent,
      "x-request-id": "",
      ...(authorization ? { authorization: authorization } : {}),
    };
    cache.currentHeaders = extractedHeaders;
    cache.cachedQwenHeaders = {
      headers: extractedHeaders,
      chatSessionId: "",
      parentMessageId: null,
    };
    cache.lastHeadersTime = Date.now();
    cache.refreshInProgress = false;
    markAccountReady(cacheKey);
    return cache.cachedQwenHeaders;
  }

  // Capture authorization Bearer token from page requests after navigation.
  // After UI login and navigation to /c/new-chat, the page automatically includes
  // authorization: Bearer on all API requests. We capture it via request listener,
  // which is more reliable than route interception + button click.
  let capturedHeaders: Record<string, string> | null = null;
  const requestListener = (req: any) => {
    const u = req.url();
    if (
      !u.includes("chat.qwen.ai/api/v2") ||
      u.includes("analytics") ||
      u.includes("aplus") ||
      u.includes("fourier.taobao")
    )
      return;
    const h = req.headers();
    if (h["authorization"] && h["bx-ua"]) {
      capturedHeaders = {
        cookie: h["cookie"] || "",
        "bx-ua": h["bx-ua"] || "",
        "bx-umidtoken": h["bx-umidtoken"] || "",
        "bx-v": h["bx-v"] || "",
        "x-request-id": h["x-request-id"] || "",
        "user-agent": h["user-agent"] || "",
        authorization: h["authorization"] || "",
      };
    }
  };

  page.on("request", requestListener);

  // Trigger a fetch from the page context in the main world. Qwen's frontend
  // fetch interceptor will apply correctly here and add the authorization header.
  try {
    await page
      .evaluate(
        async () => {
          await fetch("/api/v2/users/status", {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          });
        },
        { world: "main" },
      )
      .catch(() => {
        /* ignore fetch errors */
      });
  } catch {
    /* ignore */
  }

  try {
    // Wait up to 15 seconds for a request with authorization header
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (capturedHeaders) break;
    }
  } finally {
    page.removeListener("request", requestListener);
  }

  if (capturedHeaders) {
    cache.currentHeaders = capturedHeaders;
    cache.cachedQwenHeaders = {
      headers: capturedHeaders,
      chatSessionId: "",
      parentMessageId: null,
    };
    cache.lastHeadersTime = Date.now();
    cache.refreshInProgress = false;
    markAccountReady(cacheKey);
    return cache.cachedQwenHeaders;
  }

  throw new Error(
    `Failed to capture Qwen headers (authorization bearer token) for ${cacheKey}`,
  );
}
