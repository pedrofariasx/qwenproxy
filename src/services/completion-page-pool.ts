import type { Page } from 'playwright';
import { config } from '../core/config.js';

interface IdleCompletionPage { page: Page; timer: ReturnType<typeof setTimeout> }
const idlePages = new WeakMap<Page, IdleCompletionPage>();

async function closePage(page: Page): Promise<void> {
  try { await page.close(); }
  catch (error) { if (!page.isClosed()) throw error; }
}

export async function acquireCompletionPage(base: Page, create: () => Promise<Page>): Promise<Page> {
  const idle = idlePages.get(base);
  if (idle) {
    idlePages.delete(base);
    clearTimeout(idle.timer);
    if (!base.isClosed() && !idle.page.isClosed() && idle.page.context() === base.context() && idle.page.url().startsWith('https://chat.qwen.ai/')) return idle.page;
    await closePage(idle.page);
  }
  return create();
}

export async function releaseCompletionPage(base: Page, page: Page, reusable: boolean): Promise<void> {
  const ttl = config.completionPageIdleTtlMs;
  if (!reusable || ttl === 0 || base.isClosed() || page.isClosed() || page.context() !== base.context() || idlePages.has(base)) {
    await closePage(page);
    return;
  }
  const idle: IdleCompletionPage = { page, timer: setTimeout(() => {
    if (idlePages.get(base) !== idle) return;
    idlePages.delete(base);
    void closePage(page).catch(() => {});
  }, ttl) };
  idle.timer.unref?.();
  idlePages.set(base, idle);
}
