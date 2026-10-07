# AGENTS.md

Guide for AI agents working in this repository.

## Project overview

`@pedrofariasx/qwenproxy` — local OpenAI-compatible proxy that routes requests to Qwen (chat.qwen.ai) via Playwright browser automation. Node.js >= 20, TypeScript (ESM, strict), Hono HTTP server, better-sqlite3 for persistence.

## Essential commands

| Command | Purpose |
|---|---|
| `npm run dev` | Server (tsx watch) + admin web dev server concurrently |
| `npm start` | Start proxy (builds admin web first via `prestart`) |
| `npm run login` | Interactive browser login to capture Qwen session |
| `npm run build` | Compile backend (`tsc -p tsconfig.build.json` → `dist/`) |
| `npm run build:admin` | Build admin web UI (`web/`, Vite) |
| `npm test` | Full suite (unit + e2e) |
| `npm run test:unit` | Fast, hermetic unit tests (`src/tests/unit/`) |
| `npm run test:e2e` | Integration/stress tests (`src/tests/e2e/`, requires live sessions) |
| `npm run typecheck` | `tsc --noEmit` — always run before finishing work |
| `npm run lint` | ESLint on `src/` — always run before finishing work |
| `npm run lint:fix` | ESLint with auto-fix |

Run a single test file: `npx tsx --test src/tests/unit/parser.test.ts`

## Testing

- Runner: Node's built-in test runner via `tsx --test`, using `node:test` + `node:assert` (no Jest/Vitest).
- Tests are split into two directories:
  - `src/tests/unit/` — fast, hermetic tests (safe to run anytime, run in CI).
  - `src/tests/e2e/` — integration/stress tests (`agenticStress`, `concurrency`, `multiUser`, `hybridSessions`, etc.) that can start browsers, require live sessions/accounts, and take many minutes.
- Media fixtures: `src/tests/media/`.
- Prefer `npm run test:unit` (or targeted test files) over `npm test`; the e2e suite should not run in normal development loops.
- Always run `npm run test:unit` after changes that touch parsing, streaming, tool calls, or account scheduling logic.

## Architecture

```
src/
  index.ts            Entry point (CLI args via commander)
  login.ts            Interactive session login flow
  api/                Hono server: server.ts, admin.ts, admin-dashboard.ts, models.ts
  core/               Config, accounts, database (better-sqlite3), logger, metrics,
                      account-manager, account-lanes, watchdog, usage-tracker, tokenizer
  routes/             HTTP routes: chat.ts (chat completions), upload.ts, tool-handler.ts,
                      stream-handler.ts, sse-parser.ts
  services/           Playwright layer: browser-manager, stream-creator, stream-bridge,
                      session-manager, session-keeper, warm-pool, header-interceptor,
                      stealth, fingerprint, human-behavior, captcha-solver
  cache/              In-memory cache
  cli/                Banner and CLI commands (accounts, logs, status, tui)
  tools/              Tool-call schema, registry, streaming parser, tag handling
  utils/              Stream parser, JSON repair, truncation detection, sleep, types
  tests/              All tests (node:test)
    unit/             Fast, hermetic unit tests (run in CI)
    e2e/              Integration/stress tests (manual, live sessions)
    media/            Test fixtures
web/                  Admin dashboard: React + Vite + Tailwind + shadcn/ui (Radix)
data/                 SQLite database (gitignored)
qwen_profiles/        Playwright browser profiles with sessions (gitignored)
```

Request flow: Hono route (`routes/chat.ts`) → account selection (`core/account-manager`, lanes) → browser session (`services/browser-manager`, warm-pool) → stream capture (`services/stream-creator`/`stream-bridge`) → SSE/OpenAI-format response (`routes/stream-handler.ts`).

## Conventions

- TypeScript strict mode; ESM imports (`.js`-less, bundler resolution). Do not loosen tsconfig.
- No code comments unless explicitly requested.
- Do not add new dependencies without checking they aren't already covered (hono, zod, ajv, commander, chalk, uuid, tiktoken are available).
- Follow existing file/module patterns; mimic surrounding code style.
- Settings come from env vars — see `.env.example`; never hardcode. Never commit `.env` (gitignored), tokens, cookies, or profile data.
- `qwen_profiles/` and `data/` contain secrets/session state — never commit or log their contents.

## CI

`.github/workflows/ci.yml` runs `npm run lint`, `npm run typecheck`, and `npm run test:unit` on Node 20 for pushes/PRs to `main`/`master`. All three must pass locally before pushing.

## Docker

- Image based on `mcr.microsoft.com/playwright` (noble), uses `dumb-init`/`gosu` via `docker-entrypoint.sh`.
- `docker-compose.yml` defines a healthcheck and persists `data/` + `qwen_profiles/` volumes.
- Keep Dockerfile layer order cache-friendly (package files before source).

## Releases

semantic-release with conventional commits (see `.releaserc.json`, CHANGELOG.md auto-generated). Use commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Never commit or tag releases manually; do not add `[skip ci]` unless asked.

## Agent rules

1. Before finishing any change: run `npm run lint` and `npm run typecheck`; fix all errors.
2. Run only the test files relevant to the change unless the user asks for the full suite.
3. Never commit, push, or open PRs unless explicitly asked.
4. Never store secrets in code; read config via existing `core/config.ts` / `core/env-settings.ts` patterns.
