import type { Page } from "patchright";
import { config } from "../core/config.js";
import { getRuntimeBool, getRuntimeInt } from "../core/runtime-config.js";
import { metrics } from "../core/metrics.js";
import {
  getBearerTokenExpiryMs,
  isBearerTokenExpired,
} from "../utils/access-token.js";
import {
  markAccountReady,
  markAccountNotReady,
} from "../core/account-manager.js";
import { getAccountCredentials } from "../core/accounts.js";
import { getBaseAccountId } from "../core/account-lanes.js";

export type AuthState =
  | "unauthenticated"
  | "authenticating"
  | "ready"
  | "refreshing"
  | "degraded";

export interface HeaderStore {
  currentHeaders: Record<string, string>;
  lastHeadersTime: number;
}

type StoreAccessor = (accountId: string) => HeaderStore;

let storeAccessor: StoreAccessor | null = null;

export function registerHeaderStoreAccessor(fn: StoreAccessor): void {
  storeAccessor = fn;
}

interface AuthSession {
  accountId: string;
  state: AuthState;
  expiresAt: number | null;
  lastRefreshAt: number;
  lastFailureAt: number;
  consecutiveFailures: number;
  nextAttemptAt: number;
  inflight: Promise<string | null> | null;
  renewals: number;
  failures: number;
  lastTier: string | null;
}

const sessions = new Map<string, AuthSession>();

let keeperTimer: ReturnType<typeof setInterval> | null = null;

function key(accountId?: string): string {
  return accountId || "global";
}

function session(accountId?: string): AuthSession {
  const id = key(accountId);
  let s = sessions.get(id);
  if (!s) {
    s = {
      accountId: id,
      state: "unauthenticated",
      expiresAt: null,
      lastRefreshAt: 0,
      lastFailureAt: 0,
      consecutiveFailures: 0,
      nextAttemptAt: 0,
      inflight: null,
      renewals: 0,
      failures: 0,
      lastTier: null,
    };
    sessions.set(id, s);
  }
  return s;
}

function getStore(accountId?: string): HeaderStore | null {
  if (!storeAccessor) return null;
  try {
    return storeAccessor(key(accountId));
  } catch {
    return null;
  }
}

export function isAuthSessionEnabled(): boolean {
  return getRuntimeBool("AUTH_SESSION_ENABLED", config.authSession.enabled);
}

function getSkewMs(): number {
  return getRuntimeInt("TOKEN_REFRESH_SKEW_MS", config.authSession.skewMs);
}

export function noteAccessToken(
  accountId: string | undefined,
  token: string | null,
  source = "capture",
): void {
  const s = session(accountId);
  if (!token) {
    s.state = "unauthenticated";
    s.expiresAt = null;
    return;
  }
  const clean = token.replace(/^Bearer\s+/i, "").trim();
  const exp = getBearerTokenExpiryMs(`Bearer ${clean}`);
  s.expiresAt = exp;
  s.lastRefreshAt = Date.now();
  s.consecutiveFailures = 0;
  s.nextAttemptAt = 0;
  s.lastTier = source;
  s.state = "ready";
  const store = getStore(accountId);
  if (store) {
    store.currentHeaders["authorization"] = `Bearer ${clean}`;
    store.lastHeadersTime = Date.now();
  }
  markAccountReady(key(accountId));
  metrics.increment("auth.token.refresh", 1, {
    result: "success",
    tier: source,
  });
}

export function invalidateAccessToken(
  accountId: string | undefined,
  reason: string,
): void {
  const s = session(accountId);
  s.expiresAt = 0;
  s.state = "degraded";
  s.lastFailureAt = Date.now();
  s.consecutiveFailures += 1;
  s.nextAttemptAt = 0;
  const store = getStore(accountId);
  if (store && store.currentHeaders) {
    delete store.currentHeaders["authorization"];
  }
  markAccountNotReady(key(accountId));
  metrics.increment("auth.token.invalidated", 1, { reason });
}

export function isAuthorizationUsable(accountId?: string): boolean {
  const s = session(accountId);
  if (s.expiresAt !== null) {
    return s.expiresAt - getSkewMs() > Date.now();
  }
  const store = getStore(accountId);
  const auth = store?.currentHeaders?.["authorization"];
  if (!auth) return false;
  return !isBearerTokenExpired(auth, getSkewMs());
}

export function getAuthorizationHeader(accountId?: string): string | null {
  const store = getStore(accountId);
  const auth = store?.currentHeaders?.["authorization"];
  if (!auth) return null;
  if (isBearerTokenExpired(auth, getSkewMs())) return null;
  return auth;
}

async function tierDirectRequest(
  page: Page,
  timeoutMs = 15000,
): Promise<string | null> {
  const { refreshQwenAccessToken } = await import("./browser-manager.js");
  return refreshQwenAccessToken(page, timeoutMs);
}

async function tierPageReload(
  page: Page,
  timeoutMs = 20000,
): Promise<string | null> {
  const { renewAccessTokenViaPage } = await import("./browser-manager.js");
  return renewAccessTokenViaPage(page, timeoutMs);
}

async function tierReLogin(
  accountId: string,
  page: Page,
): Promise<string | null> {
  const creds = getAccountCredentials(getBaseAccountId(accountId) || accountId);
  if (!creds?.email || !creds.password) return null;
  const {
    loginToQwenWithContext,
    saveStorageState,
    installAccessTokenCapture,
  } = await import("./browser-manager.js");
  const ctx = page.context();
  const capture = installAccessTokenCapture(page);
  const ok = await loginToQwenWithContext(
    ctx,
    page,
    creds.email,
    creds.password,
  );
  if (!ok) return null;
  const captured = await capture.waitForToken(15000);
  if (captured) {
    await saveStorageState(ctx, getBaseAccountId(accountId) || accountId).catch(
      () => {},
    );
    return captured;
  }
  const direct = await tierDirectRequest(page, 10000);
  if (direct) {
    await saveStorageState(ctx, getBaseAccountId(accountId) || accountId).catch(
      () => {},
    );
    return direct;
  }
  return null;
}

async function executeRenewalLadder(
  accountId: string,
  targetPage?: Page,
): Promise<string | null> {
  const { accountPages, getActivePage, waitForAccountPage } =
    await import("./browser-manager.js");
  let page: Page | null = targetPage ?? null;
  if (!page) {
    page =
      accountPages.get(accountId) ??
      (accountId === "global" ? getActivePage() : null);
  }
  if (!page || page.isClosed()) {
    page = await waitForAccountPage(
      accountId === "global" ? undefined : accountId,
      15000,
    );
  }
  if (!page || page.isClosed()) {
    return null;
  }

  let token = await tierDirectRequest(page, 15000).catch(() => null);
  if (token) {
    noteAccessToken(accountId, token, "direct-request");
    return `Bearer ${token}`;
  }

  token = await tierPageReload(page, 20000).catch(() => null);
  if (token) {
    noteAccessToken(accountId, token, "page-reload");
    return `Bearer ${token}`;
  }

  token = await tierReLogin(accountId, page).catch(() => null);
  if (token) {
    noteAccessToken(accountId, token, "re-login");
    return `Bearer ${token}`;
  }

  return null;
}

export async function renewAuthorization(
  accountId?: string,
  page?: Page,
): Promise<string | null> {
  const id = key(accountId);
  const s = session(id);
  if (s.inflight) {
    return s.inflight;
  }
  if (s.nextAttemptAt > Date.now()) {
    return null;
  }
  s.state = "refreshing";
  const promise = (async () => {
    try {
      const res = await executeRenewalLadder(id, page);
      if (res) {
        s.renewals += 1;
        return res;
      }
      s.failures += 1;
      s.consecutiveFailures += 1;
      s.lastFailureAt = Date.now();
      const backoff = Math.min(
        60000,
        2000 * Math.pow(2, Math.min(s.consecutiveFailures, 5)),
      );
      s.nextAttemptAt = Date.now() + backoff;
      s.state = "degraded";
      metrics.increment("auth.token.refresh", 1, { result: "failure" });
      return null;
    } catch {
      s.failures += 1;
      s.consecutiveFailures += 1;
      s.lastFailureAt = Date.now();
      s.nextAttemptAt = Date.now() + 5000;
      s.state = "degraded";
      metrics.increment("auth.token.refresh", 1, { result: "error" });
      return null;
    } finally {
      s.inflight = null;
    }
  })();
  s.inflight = promise;
  return promise;
}

export async function ensureAuthorization(
  accountId?: string,
  page?: Page,
): Promise<string | null> {
  if (isAuthorizationUsable(accountId)) {
    const cached = getAuthorizationHeader(accountId);
    if (cached) return cached;
  }
  return renewAuthorization(accountId, page);
}

export function getAuthSessionStats(): Record<
  string,
  {
    state: AuthState;
    expiresAt: number | null;
    renewals: number;
    failures: number;
    lastTier: string | null;
  }
> {
  const out: Record<
    string,
    {
      state: AuthState;
      expiresAt: number | null;
      renewals: number;
      failures: number;
      lastTier: string | null;
    }
  > = {};
  for (const [id, s] of sessions.entries()) {
    out[id] = {
      state: s.state,
      expiresAt: s.expiresAt,
      renewals: s.renewals,
      failures: s.failures,
      lastTier: s.lastTier,
    };
  }
  return out;
}

export function startAuthSessionKeeper(): void {
  if (keeperTimer) return;
  keeperTimer = setInterval(async () => {
    if (!isAuthSessionEnabled()) return;
    const now = Date.now();
    const skew = getSkewMs();
    for (const [id, s] of sessions.entries()) {
      if (s.state === "ready" && s.expiresAt !== null) {
        if (s.expiresAt - skew <= now && !s.inflight) {
          renewAuthorization(id).catch(() => {});
        }
      }
    }
  }, 30000);
}

export function stopAuthSessionKeeper(): void {
  if (keeperTimer) {
    clearInterval(keeperTimer);
    keeperTimer = null;
  }
}

export function resetAuthSessions(): void {
  sessions.clear();
}
