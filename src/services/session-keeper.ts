import type { Page } from 'playwright';
import { accountPages, getPageForAccount, sleep } from './browser-manager.js';
import { humanMouseMove, humanScroll, humanDelay } from './human-behavior.js';
import { config } from '../core/config.js';
import { isMouseLocked } from './mouse-lock.js';

const KEEP_ALIVE_INTERVAL_MS = 3 * 60 * 1000;
const NAVIGATION_INTERVAL_MS = 8 * 60 * 1000;

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
const lastNavigation = new Map<string, number>();

async function performKeepAlive(accountId: string, page: Page): Promise<void> {
  if (page.isClosed()) return;

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

    const now = Date.now();
    const lastNav = lastNavigation.get(accountId) || 0;

    if (now - lastNav > NAVIGATION_INTERVAL_MS) {
      const currentUrl = page.url();
      if (!currentUrl.includes('chat.qwen.ai')) {
        await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
      } else {
        await page.evaluate(() => {
          try {
            const el = document.querySelector('[data-testid="sidebar"], .sidebar, nav, aside');
            if (el) {
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
            }
          } catch { /* ignore */ }
        });
      }
      lastNavigation.set(accountId, now);
    }
  } catch (err: any) {
    if (!err.message?.includes('Target closed') && !err.message?.includes('Page is closed')) {
      console.warn(`[SessionKeeper] Keep-alive failed for ${accountId}:`, err.message);
    }
  }
}

export function startSessionKeeper(): void {
  if (!config.sessionKeeper.enabled) {
    console.log('[SessionKeeper] Disabled');
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
      if (accountId.includes('::lane-') && !accountId.endsWith('::lane-1')) continue;
      if (page.isClosed()) continue;
      await performKeepAlive(accountId, page);
      await sleep(humanDelay(1000, 3000));
    }

    if (isMouseLocked()) {
      return;
    }

    const defaultPage = getPageForAccount();
    if (defaultPage && !defaultPage.isClosed()) {
      await performKeepAlive('_default', defaultPage);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  console.log('[SessionKeeper] Started — keep-alive every ~3min, navigation every ~8min');
}

export function stopSessionKeeper(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastNavigation.clear();
  console.log('[SessionKeeper] Stopped');
}
