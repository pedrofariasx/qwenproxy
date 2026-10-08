import type { Page } from 'playwright';
import { accountPages, getPageForAccount, getUiMutex, getBrowser, sleep } from './browser-manager.js';
import { humanMouseMove, humanScroll, humanDelay } from './human-behavior.js';
import { config } from '../core/config.js';
import { isMouseLocked } from './mouse-lock.js';
import { getAccountCredentials } from '../core/accounts.js';
import type { QwenAccount } from '../core/accounts.js';
import { getAccountCooldownInfo, isAccountReady, getReadyAccountCount, getInUseAccounts, getAccountsWithCooldownSync, getAccountActiveLoad } from '../core/account-manager.js';
import { getBaseAccountId } from '../core/account-lanes.js';

const KEEP_ALIVE_INTERVAL_MS = 3 * 60 * 1000;
const NAVIGATION_INTERVAL_MS = 8 * 60 * 1000;

let running = false;
let recoveryInterval: ReturnType<typeof setInterval> | null = null;
let recoveryInProgress = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
const lastNavigation = new Map<string, number>();

export async function recoverUnreadyAccounts(
  prepare: (account: QwenAccount) => Promise<void> = async account => {
    const { initPlaywrightForAccount } = await import('./browser-manager.js');
    const { getQwenHeaders } = await import('./header-interceptor.js');
    const credentials = getAccountCredentials(getBaseAccountId(account.id));
    if (!credentials) return;
    await initPlaywrightForAccount({ ...credentials, id: account.id }, config.browser.headless, config.browser.type);
    await getQwenHeaders(true, account.id);
  },
): Promise<void> {
  if (recoveryInProgress || isMouseLocked()) return;
  recoveryInProgress = true;
  try {
    for (const account of getAccountsWithCooldownSync()) {
      if (isAccountReady(account.id) || getInUseAccounts().includes(account.id) || getAccountActiveLoad(account.id) > 0 || getAccountCooldownInfo(account.id) || getUiMutex(account.id).isLocked()) continue;
      try {
        await prepare(account);
      } catch (error) {
        console.warn(`[SessionKeeper] Account ${account.id} is not ready; recovery will retry: ${(error as Error).message}`);
        if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|EAI_AGAIN/.test((error as Error).message) &&
            getReadyAccountCount() === 0 && getInUseAccounts().length === 0 &&
            getAccountsWithCooldownSync().every(entry => getAccountActiveLoad(entry.id) === 0 && !getUiMutex(entry.id).isLocked())) {
          await getBrowser()?.close().catch(() => {});
        }
      }
    }
  } finally {
    recoveryInProgress = false;
  }
}

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
        await page.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
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
  recoveryInterval = setInterval(() => {
    if (running) recoverUnreadyAccounts().catch(error => console.warn('[SessionKeeper] Recovery failed:', error.message));
  }, 30000);
  recoveryInterval.unref();

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
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastNavigation.clear();
  console.log('[SessionKeeper] Stopped');
}
