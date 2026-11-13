import type { Page } from "patchright";
import {
  QWEN_BX_VERSION_FALLBACK,
  QWEN_WEB_VERSION_FALLBACK,
} from "../utils/qwen-constants.js";

/**
 * The Qwen web client is published to a versioned CDN path, so the build
 * version is embedded in every asset URL it serves:
 *   //assets.alicdn.com/g/qwenweb/qwen-chat-fe/<version>/js/main.js
 * The same literal is also the `version` header the frontend sends on every
 * API call, so detecting it keeps our requests in sync with the live client.
 */
const QWEN_ASSET_VERSION_RE = /qwenweb\/qwen-chat-fe\/(\d+\.\d+\.\d+)/;

/** The Aliyun Baxia anti-bot SDK is loaded from a versioned path as well. */
const BAXIA_VERSION_RE = /\/sd\/baxia\/(\d+\.\d+\.\d+)\//;

let detectedWebVersion: string | null = null;
let detectedBxVersion: string | null = null;

/** Current `version` header value, falling back to the last known default. */
export function getQwenWebVersion(): string {
  return detectedWebVersion ?? QWEN_WEB_VERSION_FALLBACK;
}

/** Current `bx-v` header value, falling back to the last known default. */
export function getBxVersion(): string {
  return detectedBxVersion ?? QWEN_BX_VERSION_FALLBACK;
}

/** Stores versions observed on real traffic so later requests reuse them. */
export function rememberQwenVersions(versions: {
  webVersion?: string | null;
  bxVersion?: string | null;
}): void {
  if (versions.webVersion) detectedWebVersion = versions.webVersion;
  if (versions.bxVersion) detectedBxVersion = versions.bxVersion;
}

/**
 * Reads the Qwen web build version from the served HTML/assets. Works before
 * any script executes, so it is available as soon as the DOM is parsed.
 */
export async function detectQwenWebVersion(page: Page): Promise<string | null> {
  try {
    return await page.evaluate((source) => {
      const re = new RegExp(source);
      const candidates: string[] = [];

      for (const el of Array.from(
        document.querySelectorAll("link[href], script[src]"),
      )) {
        candidates.push(el.getAttribute("href") || "");
        candidates.push(el.getAttribute("src") || "");
      }

      for (const url of candidates) {
        const match = url.match(re);
        if (match) return match[1];
      }

      for (const entry of performance.getEntriesByType("resource")) {
        const match = entry.name.match(re);
        if (match) return match[1];
      }

      const htmlMatch = document.documentElement.outerHTML.match(re);
      return htmlMatch ? htmlMatch[1] : null;
    }, QWEN_ASSET_VERSION_RE.source);
  } catch {
    return null;
  }
}

/**
 * Reads the Aliyun Baxia SDK version from the global it exposes. The entry
 * script loads asynchronously, so this polls until it appears.
 */
export async function detectBaxiaVersion(
  page: Page,
  timeoutMs = 8000,
): Promise<string | null> {
  const read = (): Promise<string | null> =>
    page
      .evaluate((source) => {
        const re = new RegExp(source);
        const baxia = (window as any).baxiaCommon;
        if (
          baxia &&
          typeof baxia.version === "string" &&
          /^\d+\.\d+\.\d+$/.test(baxia.version)
        ) {
          return baxia.version;
        }
        for (const entry of performance.getEntriesByType("resource")) {
          const match = entry.name.match(re);
          if (match) return match[1];
        }
        for (const el of Array.from(document.querySelectorAll("script[src]"))) {
          const match = (el.getAttribute("src") || "").match(re);
          if (match) return match[1];
        }
        return null;
      }, BAXIA_VERSION_RE.source)
      .catch(() => null);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const version = await read();
    if (version) return version;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(400).catch(() => {});
  }
}

/**
 * Detects both version constants from the live page and caches them.
 * Safe to call repeatedly; detection is skipped once both values are known.
 */
export async function refreshQwenVersions(
  page: Page,
): Promise<{ webVersion: string; bxVersion: string }> {
  const [webVersion, bxVersion] = await Promise.all([
    detectedWebVersion
      ? Promise.resolve(detectedWebVersion)
      : detectQwenWebVersion(page),
    detectedBxVersion
      ? Promise.resolve(detectedBxVersion)
      : detectBaxiaVersion(page),
  ]);

  rememberQwenVersions({ webVersion, bxVersion });

  return { webVersion: getQwenWebVersion(), bxVersion: getBxVersion() };
}
