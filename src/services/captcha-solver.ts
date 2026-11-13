import type { Page } from "patchright";
import { humanDrag } from "./human-behavior.js";
import { acquireMouseLock, releaseMouseLock } from "./mouse-lock.js";
import { sleep } from "../utils/sleep.js";
import { config } from "../core/config.js";
import { getRuntimeInt } from "../core/runtime-config.js";

export const BAXIA_IFRAME_SELECTOR =
  'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"], iframe[src*="nocaptcha"]';
export const ALIYUN_WAF_CAPTCHA_SELECTOR = "#waf_nc_block";
export const ALIYUN_WAF_CAPTCHA_WIDGET = "#aliyunCaptcha-window-embed";

const getSliderTimeoutMs = () =>
  getRuntimeInt("CAPTCHA_SLIDER_TIMEOUT_MS", config.captcha.sliderTimeoutMs);
const getMaxCaptchaAttempts = () =>
  getRuntimeInt("CAPTCHA_MAX_ATTEMPTS", config.captcha.maxAttempts);

/**
 * Solves the Aliyun WAF puzzle captcha that appears during Qwen login.
 * The captcha renders as an embedded div (not an iframe) containing a
 * background image and a puzzle piece that must be dragged to the correct
 * position on a slider track.
 */
export async function solveAliyunWafCaptcha(page: Page): Promise<boolean> {
  const blockLocator = page.locator(ALIYUN_WAF_CAPTCHA_SELECTOR);

  if (!(await blockLocator.isVisible().catch(() => false))) {
    return false;
  }

  while (!acquireMouseLock("captcha-solver")) {
    console.log(
      "[Captcha] Waiting for mouse lock to be released before solving...",
    );
    await sleep(200);
  }

  console.log(
    "[Captcha] Aliyun WAF puzzle captcha detected. Attempting to solve...",
  );

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const offset = await page.evaluate(() => {
          const img = document.querySelector(
            "#aliyunCaptcha-img",
          ) as HTMLImageElement | null;
          const puzzle = document.querySelector(
            "#aliyunCaptcha-puzzle",
          ) as HTMLImageElement | null;
          if (!img || !puzzle)
            return { ok: false, reason: "missing puzzle images" };

          return new Promise<{
            ok: boolean;
            offsetX?: number;
            reason?: string;
          }>((resolve) => {
            if (img.complete && puzzle.complete) {
              resolve(computeOffset(img, puzzle));
            } else {
              img.onload = puzzle.onload = () =>
                resolve(computeOffset(img, puzzle));
              img.onerror = puzzle.onerror = () =>
                resolve({ ok: false, reason: "image load error" });
            }
          });

          function computeOffset(
            bg: HTMLImageElement,
            piece: HTMLImageElement,
          ): { ok: boolean; offsetX?: number; reason?: string } {
            try {
              const W = bg.naturalWidth;
              const H = bg.naturalHeight;
              const pW = piece.naturalWidth;
              const pH = piece.naturalHeight;

              const c = document.createElement("canvas");
              c.width = W;
              c.height = H;
              const ctx = c.getContext("2d");
              if (!ctx) return { ok: false, reason: "no canvas context" };

              try {
                ctx.drawImage(bg, 0, 0);
              } catch {
                return { ok: false, reason: "canvas tainted (CORS)" };
              }
              const bgData = ctx.getImageData(0, 0, W, H).data;

              const pc = document.createElement("canvas");
              pc.width = pW;
              pc.height = pH;
              const pctx = pc.getContext("2d");
              if (!pctx)
                return { ok: false, reason: "no puzzle canvas context" };

              try {
                pctx.drawImage(piece, 0, 0);
              } catch {
                return { ok: false, reason: "puzzle canvas tainted (CORS)" };
              }
              const puzzleData = pctx.getImageData(0, 0, pW, pH).data;

              let pMinX = pW,
                pMaxX = 0,
                pMinY = pH,
                pMaxY = 0;
              for (let y = 0; y < pH; y++) {
                for (let x = 0; x < pW; x++) {
                  if (puzzleData[(y * pW + x) * 4 + 3] > 100) {
                    if (x < pMinX) pMinX = x;
                    if (x > pMaxX) pMaxX = x;
                    if (y < pMinY) pMinY = y;
                    if (y > pMaxY) pMaxY = y;
                  }
                }
              }
              const pieceWidth = pMaxX - pMinX + 1;

              const yStart = pMinY + 5;
              const yEnd = pMaxY - 5;
              const colGradients = new Float32Array(W);
              for (let x = 1; x < W - 1; x++) {
                let grad = 0;
                for (let y = yStart; y <= yEnd; y++) {
                  const l = (y * W + x - 1) * 4;
                  const r = (y * W + x + 1) * 4;
                  grad +=
                    Math.abs(bgData[r] - bgData[l]) +
                    Math.abs(bgData[r + 1] - bgData[l + 1]) +
                    Math.abs(bgData[r + 2] - bgData[l + 2]);
                }
                colGradients[x] = grad;
              }

              let bestX = 0;
              let bestScore = -1;
              const minCandidateX = 30;
              const maxCandidateX = W - pieceWidth - 20;

              for (
                let candidateX = minCandidateX;
                candidateX <= maxCandidateX;
                candidateX++
              ) {
                let leftMax = 0;
                for (let dx = -2; dx <= 2; dx++) {
                  const gx = colGradients[candidateX + pMinX + dx] || 0;
                  if (gx > leftMax) leftMax = gx;
                }

                let rightMax = 0;
                for (let dx = -3; dx <= 1; dx++) {
                  const gx = colGradients[candidateX + pMaxX + dx] || 0;
                  if (gx > rightMax) rightMax = gx;
                }

                const pairScore = Math.sqrt(leftMax * rightMax);
                if (pairScore > bestScore) {
                  bestScore = pairScore;
                  bestX = candidateX;
                }
              }

              return { ok: true, offsetX: bestX - pMinX };
            } catch (e: any) {
              return { ok: false, reason: e.message };
            }
          }
        });

        if (!offset.ok) {
          console.warn(`[Captcha] Attempt ${attempt}: ${offset.reason}`);
          await sleep(1000);
          continue;
        }

        const sliderBox = await page
          .locator("#aliyunCaptcha-sliding-slider")
          .boundingBox();
        const bodyBox = await page
          .locator("#aliyunCaptcha-sliding-body")
          .boundingBox();
        if (!sliderBox || !bodyBox) {
          console.warn(
            `[Captcha] Attempt ${attempt}: Slider or track bounding box not found.`,
          );
          await sleep(1000);
          continue;
        }

        const imgInfo = await page.evaluate(() => {
          const el = document.querySelector(
            "#aliyunCaptcha-img",
          ) as HTMLImageElement | null;
          return el
            ? { naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight }
            : null;
        });
        if (!imgInfo) {
          console.warn(
            `[Captcha] Attempt ${attempt}: Could not read image dimensions.`,
          );
          await sleep(1000);
          continue;
        }

        const scaleX = bodyBox.width / imgInfo.naturalWidth;
        const dragDistance = offset.offsetX! * scaleX;
        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;
        const endX = startX + dragDistance;
        const endY = startY;

        console.log(
          `[Captcha] Attempt ${attempt}: Dragging slider from x=${startX.toFixed(1)}, y=${startY.toFixed(1)} by ${dragDistance.toFixed(1)}px`,
        );

        await humanDrag(page, startX, startY, endX, endY);

        await sleep(2000);

        const isGone = !(await blockLocator.isVisible().catch(() => false));
        if (isGone) {
          console.log(
            "[Captcha] Aliyun WAF puzzle captcha solved successfully.",
          );
          return true;
        }

        console.warn(
          `[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`,
        );
        await sleep(1000);
      } catch (err: any) {
        console.error(
          `[Captcha] Error during attempt ${attempt}:`,
          err.message,
        );
        await sleep(1000);
      }
    }

    console.error(
      "[Captcha] Failed to solve Aliyun WAF puzzle captcha after 3 attempts.",
    );
    return false;
  } finally {
    releaseMouseLock("captcha-solver");
  }
}

/**
 * Solves the Baxia slidein captcha inside an iframe on the page.
 */
export async function solveBaxiaCaptcha(page: Page): Promise<boolean> {
  const iframeLocator = page.locator(BAXIA_IFRAME_SELECTOR).first();

  if (!(await iframeLocator.isVisible().catch(() => false))) {
    return false;
  }

  while (!acquireMouseLock("captcha-solver")) {
    console.log(
      "[Captcha] Waiting for mouse lock to be released before solving...",
    );
    await sleep(200);
  }

  console.log(
    "[Captcha] Baxia captcha iframe detected. Attempting to solve...",
  );

  try {
    const maxAttempts = getMaxCaptchaAttempts();
    const sliderTimeoutMs = getSliderTimeoutMs();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const frame = page.frameLocator(BAXIA_IFRAME_SELECTOR);
        const slider = frame.locator(
          '#nc_1_n1z, .btn_slide, .nc_iconfont.btn_slide, span[id*="_n1z"]',
        );

        await slider.waitFor({ state: "visible", timeout: sliderTimeoutMs });

        const sliderBox = await slider.boundingBox();
        if (!sliderBox) {
          console.warn(
            `[Captcha] Attempt ${attempt}: Slider bounding box not found.`,
          );
          await sleep(1000);
          continue;
        }

        const track = frame.locator("#nc_1_n1t, .nc_scale");
        const trackBox = await track.boundingBox();
        const dragDistance = trackBox ? trackBox.width - sliderBox.width : 260;

        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;

        console.log(
          `[Captcha] Attempt ${attempt}: Dragging slider from x=${startX}, y=${startY} by ${dragDistance}px`,
        );

        const endX = startX + dragDistance;
        const endY = startY;

        await humanDrag(page, startX, startY, endX, endY);

        // Wait a moment for the page to register success and close the dialog
        await sleep(2000);

        // Verify if the captcha is solved: the iframe should be hidden/gone, or we see a success element
        const isGone = !(await iframeLocator.isVisible().catch(() => false));
        if (isGone) {
          console.log(
            "[Captcha] Baxia captcha solved successfully (iframe closed).",
          );
          return true;
        }

        const okElement = frame.locator(
          ".btn_ok, .nc_ok, div#nc-loading-circle",
        );
        const isOkVisible = await okElement.isVisible().catch(() => false);
        if (isOkVisible) {
          console.log(
            "[Captcha] Baxia captcha solved successfully (OK state detected).",
          );
          await sleep(1500); // Wait for transition
          return true;
        }

        console.warn(
          `[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`,
        );
        await sleep(1000);
      } catch (err: any) {
        console.error(
          `[Captcha] Error during attempt ${attempt}:`,
          err.message,
        );
        await sleep(1000);
      }
    }

    console.error("[Captcha] Failed to solve Baxia captcha after 3 attempts.");
    return false;
  } finally {
    releaseMouseLock("captcha-solver");
  }
}

/**
 * Starts a background loop to watch for and solve Baxia captchas on the page.
 * Returns an object with a stop() method to stop the loop.
 */
export function startCaptchaWatcher(page: Page, timeoutMs: number) {
  let finished = false;
  const promise = (async () => {
    const start = Date.now();
    while (!finished && Date.now() - start < timeoutMs) {
      try {
        if (page.isClosed()) break;
        const hasCaptcha = await page
          .locator(BAXIA_IFRAME_SELECTOR)
          .first()
          .isVisible()
          .catch(() => false);
        if (hasCaptcha) {
          console.log("[Captcha] Baxia captcha detected on page. Solving...");
          await solveBaxiaCaptcha(page);
        }
      } catch {
        // ignore
      }
      await sleep(1000);
    }
  })();

  return {
    stop: () => {
      finished = true;
    },
    promise,
  };
}
