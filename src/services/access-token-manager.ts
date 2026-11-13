import type { Page } from "patchright";
import {
  accountPages,
  getAccountHeaderCache,
  refreshQwenAccessToken,
  renewAccessTokenViaPage,
} from "./browser-manager.js";
import { getCookies } from "./header-interceptor.js";
import {
  hasExpiredBearerToken,
  isBearerTokenExpired,
} from "../utils/access-token.js";

/**
 * Central place that keeps the Qwen access token usable.
 *
 * The bearer token is a 15 minute JWT, while the proxy keeps headers, warm
 * pool chats and persisted sessions for far longer. Whenever a cached token
 * turns out to be expired the request would fail with a generic
 * "Unauthorized" error, so the token is renewed here before it is used.
 *
 * Renewal is cheap: the `refresh_token` cookie set during signin is enough
 * to mint a new access token, no interactive login required.
 */

type HeaderStore = {
  currentHeaders: Record<string, string>;
  lastHeadersTime: number;
};

function storeFor(accountId?: string): HeaderStore {
  return getAccountHeaderCache(accountId || "global") as unknown as HeaderStore;
}

/**
 * Returns the bearer token currently held for the account, or null when
 * there is none or the one we have already expired.
 */
export function getUsableBearerToken(accountId?: string): string | null {
  const store = storeFor(accountId);
  const authorization = store.currentHeaders["authorization"];
  if (!authorization) return null;
  if (isBearerTokenExpired(authorization)) return null;
  return authorization;
}

/**
 * True when the account currently holds a bearer token that has expired.
 */
export function hasExpiredToken(accountId?: string): boolean {
  const store = storeFor(accountId);
  return hasExpiredBearerToken(store.currentHeaders);
}

/**
 * Renews the access token for an account using the `refresh_token` cookie.
 *
 * Returns the new `authorization` header value, or null when the cookie is
 * missing or the renewal was rejected (in which case a full signin is
 * required).
 */
export async function renewAccessToken(
  accountId?: string,
  page?: Page,
): Promise<string | null> {
  const target = page ?? resolveAccountPage(accountId);
  if (!target) return null;

  // The refresh endpoint only accepts requests coming from the real web
  // client, so the direct request is tried first and the page reload is the
  // fallback that lets the frontend perform the refresh itself.
  let token = await refreshQwenAccessToken(target);
  if (!token) {
    token = await renewAccessTokenViaPage(target);
  }
  if (!token) return null;

  const authorization = `Bearer ${token}`;
  const store = storeFor(accountId);
  store.currentHeaders["authorization"] = authorization;
  store.lastHeadersTime = Date.now();
  return authorization;
}

/**
 * Ensures the account holds a usable access token, renewing it when the
 * cached one has expired.
 *
 * Returns true when a usable token is available afterwards.
 */
export async function ensureUsableToken(
  accountId?: string,
  page?: Page,
): Promise<boolean> {
  if (getUsableBearerToken(accountId)) return true;

  const renewed = await renewAccessToken(accountId, page);
  if (renewed) {
    console.log(
      `[Token] Renewed expired Qwen access token for ${accountId || "global"}.`,
    );
    return true;
  }

  return getUsableBearerToken(accountId) !== null;
}

/**
 * Replaces the bearer token inside a header set, keeping every other header
 * untouched. Used to upgrade headers that were captured before a renewal.
 */
export function applyBearerToken(
  headers: Record<string, string>,
  authorization: string,
): Record<string, string> {
  return { ...headers, authorization };
}

/**
 * Refreshes the cookie header of a header set from the live browser context,
 * so long-lived header sets do not keep using a stale cookie jar.
 */
export async function refreshCookieHeader(
  accountId?: string,
): Promise<string | null> {
  try {
    const cookie = await getCookies(accountId);
    return cookie || null;
  } catch {
    return null;
  }
}

function resolveAccountPage(accountId?: string): Page | null {
  if (!accountId) return null;
  try {
    return accountPages.get(accountId) ?? null;
  } catch {
    return null;
  }
}
