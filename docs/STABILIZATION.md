# Stabilization & Architecture Remediation

This document summarizes the architectural remedies applied to eliminate recurring upstream errors, token expiration failures, and direct-fetch circuit lockups.

## 1. Problem Summary
The system experienced cascading errors:
- Short-lived Qwen JWT access tokens (15-minute expiration) were captured and statically stored into warm pool chats and session state.
- Once expired, direct HTTP calls and browser calls failed with upstream `Unauthorized` (code 401).
- The error handler mapped `Unauthorized` to generic 502 Bad Gateway responses and recorded consecutive failures against the direct fetch circuit breaker.
- After consecutive failures, the direct-fetch circuit remained permanently tripped because its failure counter was never cleared on half-open probes.
- Baxia slider captcha timeouts and aggressive prompt inlining (`LARGE_PROMPT_INLINE=true`) triggered anti-bot mechanisms.

## 2. Implemented Architecture Changes

### A. AuthSession & Dynamic Token Resolution (`src/services/auth-session.ts`)
- Manages token validity and lifetime centrally with proactive safety skew (`TOKEN_REFRESH_SKEW_MS=120000`).
- Provides single-flight deduplicated token renewal across direct request, page reload, and re-login ladders.
- Invalidation signals trigger state degradation and exponential backoff rather than immediate crash loops.

### B. Live Header & Credential Injection (`src/services/warm-pool.ts`, `src/services/stream-creator.ts`)
- Dynamic authorization headers are re-evaluated and refreshed immediately before a warm chat or pinned session is leased.
- Warm pool evicts expired entries and uses exponential backoff with jitter on refill failures instead of permanently aborting.

### C. Failure Taxonomy & Circuit Breaker Reform (`src/services/failure-class.ts`, `src/services/error-handler.ts`)
- Classifies errors cleanly into `auth`, `anti-bot`, `quota`, `upstream-5xx`, `transient`, and `transport`.
- `auth` errors trigger proactive renewal without opening the direct-fetch circuit or quarantining the account.
- The direct fetch circuit breaker resets its failure counter and test-probes upon recovery timeout.

### D. Anti-bot & Prompt Safety (`src/services/captcha-solver.ts`, `.env.example`, `src/core/config.ts`)
- `LARGE_PROMPT_INLINE` default set to `false` and `LARGE_PROMPT_THRESHOLD` raised to `524288` (512 KB), preventing anti-bot triggers.
- Captcha slider selector broadened with configurable timeout (`CAPTCHA_SLIDER_TIMEOUT_MS=15000`).
