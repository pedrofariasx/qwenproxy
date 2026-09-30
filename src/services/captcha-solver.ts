import type { Page } from 'playwright';
import { humanDrag } from './human-behavior.js';
import { acquireMouseLock, releaseMouseLock } from './mouse-lock.js';
import { sleep } from '../utils/sleep.js';

export const BAXIA_IFRAME_SELECTOR = 'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"]';

/**
 * Solves the Baxia slidein captcha inside an iframe on the page.
 */
export async function solveBaxiaCaptcha(page: Page): Promise<boolean> {
  const iframeLocator = page.locator(BAXIA_IFRAME_SELECTOR).first();

  if (!(await iframeLocator.isVisible().catch(() => false))) {
    return false;
  }

  while (!acquireMouseLock('captcha-solver')) {
    console.log('[Captcha] Waiting for mouse lock to be released before solving...');
    await sleep(200);
  }

  console.log('[Captcha] Baxia captcha iframe detected. Attempting to solve...');

  try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const frame = page.frameLocator(BAXIA_IFRAME_SELECTOR);
      const slider = frame.locator('#nc_1_n1z, .btn_slide');

      // The baxia iframe frequently loads slower than the old 5s window allowed,
      // which surfaced as "locator.waitFor: Timeout 5000ms exceeded". Give it a
      // generous budget and re-locate once on a stale-frame error.
      let sliderBox: Awaited<ReturnType<typeof slider.boundingBox>> = null;
      for (let locate = 0; locate < 2; locate++) {
        try {
          await slider.waitFor({ state: 'visible', timeout: 15000 });
          sliderBox = await slider.boundingBox();
          if (sliderBox) break;
        } catch (err: any) {
          console.warn(`[Captcha] Attempt ${attempt} slider locate failed (${locate + 1}/2):`, err.message);
          await sleep(1500 * (locate + 1));
        }
      }
      if (!sliderBox) {
        console.warn(`[Captcha] Attempt ${attempt}: Slider bounding box not found.`);
        await sleep(1000);
        continue;
      }

      const track = frame.locator('#nc_1_n1t, .nc_scale');
      const trackBox = await track.boundingBox();
      const dragDistance = trackBox ? (trackBox.width - sliderBox.width) : 260;

      const startX = sliderBox.x + sliderBox.width / 2;
      const startY = sliderBox.y + sliderBox.height / 2;

      console.log(`[Captcha] Attempt ${attempt}: Dragging slider from x=${startX}, y=${startY} by ${dragDistance}px`);
      
      const endX = startX + dragDistance;
      const endY = startY;
      
      await humanDrag(page, startX, startY, endX, endY);

      // Wait a moment for the page to register success and close the dialog
      await sleep(2000);

      // Verify if the captcha is solved: the iframe should be hidden/gone, or we see a success element
      const isGone = !(await iframeLocator.isVisible().catch(() => false));
      if (isGone) {
        console.log('[Captcha] Baxia captcha solved successfully (iframe closed).');
        return true;
      }

      const okElement = frame.locator('.btn_ok, .nc_ok, div#nc-loading-circle');
      const isOkVisible = await okElement.isVisible().catch(() => false);
      if (isOkVisible) {
        console.log('[Captcha] Baxia captcha solved successfully (OK state detected).');
        await sleep(1500); // Wait for transition
        return true;
      }

      console.warn(`[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`);
      await sleep(1000 * attempt);
    } catch (err: any) {
      console.error(`[Captcha] Error during attempt ${attempt}:`, err.message);
      await sleep(1000 * attempt);
    }
  }

  console.error('[Captcha] Failed to solve Baxia captcha after 3 attempts.');
  return false;
  } finally {
    releaseMouseLock('captcha-solver');
  }
}

/**
 * Starts a background loop to watch for and solve Baxia captchas on the page.
 * Returns an object with a stop() method to stop the loop.
 */
export function startCaptchaWatcher(page: Page, timeoutMs: number) {
  let finished = false;
  let solveInFlight = false;

  const maybeSolve = async () => {
    if (finished || solveInFlight) return;
    if (page.isClosed()) return;
    solveInFlight = true;
    try {
      const hasCaptcha = await page.locator(BAXIA_IFRAME_SELECTOR).first().isVisible().catch(() => false);
      if (hasCaptcha && !finished) {
        console.log('[Captcha] Baxia captcha detected on page. Solving...');
        await solveBaxiaCaptcha(page);
      }
    } catch {
      // ignore
    } finally {
      solveInFlight = false;
    }
  };

  // Event-driven detection (the punish iframe arrives via a frame navigation)
  // plus a slow safety poll, instead of the old 1s CDP poll on every lane that
  // contended with header capture and screenshots. The event API is feature-
  // detected so lightweight page stand-ins (tests) still work via the poll.
  const eventsSupported =
    typeof (page as any).on === 'function' && typeof (page as any).off === 'function';
  const onFrameNavigated = () => { void maybeSolve(); };
  if (eventsSupported) {
    (page as any).on('framenavigated', onFrameNavigated);
  }

  const deadline = Date.now() + timeoutMs;
  // Check immediately: a challenge already on the page at warm-up must not wait
  // for the first safety poll.
  void maybeSolve();

  const safetyPoll = setInterval(() => {
    if (finished || Date.now() >= deadline) {
      clearInterval(safetyPoll);
      return;
    }
    void maybeSolve();
  }, 5000);
  if (safetyPoll.unref) safetyPoll.unref();

  const promise = (async () => {
    while (!finished && Date.now() < deadline) {
      await sleep(500);
    }
  })();

  return {
    stop: () => {
      finished = true;
      if (eventsSupported) (page as any).off('framenavigated', onFrameNavigated);
      clearInterval(safetyPoll);
    },
    promise
  };
}
