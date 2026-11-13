import type { Page } from "patchright";
import { accountPages, getPageForAccount, sleep } from "./browser-manager.js";
import { humanMouseMove, humanScroll, humanDelay } from "./human-behavior.js";
import { config } from "../core/config.js";
import { isMouseLocked } from "./mouse-lock.js";

const KEEP_ALIVE_INTERVAL_MS = 3 * 60 * 1000;
const NAVIGATION_INTERVAL_MS = 8 * 60 * 1000;

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
const lastNavigation = new Map<string, number>();

// Track consecutive failures and next allowed retry timestamps for proactive session recovery
interface RetryState {
  failures: number;
  nextAttemptAt: number;
}
const sessionRetries = new Map<string, RetryState>();

async function performKeepAlive(accountId: string, page: Page): Promise<void> {
  if (page.isClosed()) return;

  const retryState = sessionRetries.get(accountId) || {
    failures: 0,
    nextAttemptAt: 0,
  };
  const now = Date.now();

  // If session is currently in a degraded backoff state, skip until nextAttemptAt passes
  if (retryState.failures > 0 && now < retryState.nextAttemptAt) {
    return;
  }

  try {
    const viewport = page.viewportSize();
    if (!viewport) return;

    const points = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < points; i++) {
      const fromX = Math.floor(Math.random() * viewport.width);
      const fromY = Math.floor(Math.random() * viewport.height);
      const toX = Math.floor(Math.random() * viewport.width);
      const toY = Math.floor(Math.random() * viewport.height);
      await humanMouseMove(page, fromX, fromY, toX, toY, { overshoot: 0 });
      await sleep(humanDelay(300, 800));
    }

    if (Math.random() < 0.4) {
      await humanScroll(page);
    }

    const lastNav = lastNavigation.get(accountId) || 0;

    if (now - lastNav > NAVIGATION_INTERVAL_MS) {
      const currentUrl = page.url();
      if (!currentUrl.includes("chat.qwen.ai")) {
        await page.goto("https://chat.qwen.ai/c/new-chat", {
          waitUntil: "domcontentloaded",
          timeout: config.timeouts.navigation,
        });
      } else {
        await page.evaluate(() => {
          try {
            const el = document.querySelector(
              '[data-testid="sidebar"], .sidebar, nav, aside',
            );
            if (el) {
              el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
            }
          } catch {
            /* ignore */
          }
        });
      }
      lastNavigation.set(accountId, now);
    }

    // Success: reset retry tracking counters
    if (retryState.failures > 0) {
      sessionRetries.delete(accountId);
    }
  } catch (err: any) {
    if (
      !err.message?.includes("Target closed") &&
      !err.message?.includes("Page is closed")
    ) {
      // Implement exponential backoff for degraded keeper states: 2s * 2^failures (capped at 5 mins)
      const nextFailures = Math.min(retryState.failures + 1, 5);
      const backoff = Math.min(2000 * Math.pow(2, nextFailures), 5 * 60 * 1000);
      sessionRetries.set(accountId, {
        failures: nextFailures,
        nextAttemptAt: Date.now() + backoff,
      });

      console.warn(
        `[SessionKeeper] Keep-alive failed for ${accountId} (state: degraded, retrying in ${Math.round(backoff / 1000)}s):`,
        err.message,
      );
    }
  }
}

export function startSessionKeeper(): void {
  if (!config.sessionKeeper.enabled) {
    console.log("[SessionKeeper] Disabled");
    return;
  }

  if (running) return;
  running = true;

  intervalId = setInterval(async () => {
    if (!running) return;

    if (isMouseLocked()) {
      return;
    }

    for (const [accountId, page] of accountPages.entries()) {
      if (!running) return;
      if (isMouseLocked()) {
        return;
      }
      if (accountId.includes("::lane-") && !accountId.endsWith("::lane-1"))
        continue;
      if (page.isClosed()) continue;
      await performKeepAlive(accountId, page);
      await sleep(humanDelay(1000, 3000));
    }

    if (isMouseLocked()) {
      return;
    }

    const defaultPage = getPageForAccount();
    if (defaultPage && !defaultPage.isClosed()) {
      await performKeepAlive("_default", defaultPage);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  console.log(
    "[SessionKeeper] Started — keep-alive every ~3min, navigation every ~8min",
  );
}

export function stopSessionKeeper(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastNavigation.clear();
  sessionRetries.clear();
  console.log("[SessionKeeper] Stopped");
}
