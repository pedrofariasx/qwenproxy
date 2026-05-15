# QwenProxy

A reverse proxy that translates the **Qwen Chat Web API** (`chat.qwen.ai`) into an **OpenAI-compatible** HTTP API.  
Uses Playwright for browser-based header interception and session management.

Built for tool-calling agents (OpenCode, AI SDK, etc.) that need reasoning models.

---

## Features

- **OpenAI-compatible** `POST /v1/chat/completions` (streaming + tools)
- **Reasoning / thinking** support
- **Tool execution** (parallel, streaming parser for JSON tool calls)
- **One browser context per chat identity** — each `session+agent+model` gets its own isolated Playwright `BrowserContext` with independent cookies, localStorage, and page state. No cross-contention between parallel agents.
- **Hybrid delta mode** — reuses the same Qwen chat when the conversation history matches as a prefix. Only new messages are sent, reducing token overhead.
- **Automatic login** on startup using credentials from `.env`; saves full Playwright `storageState` (cookies + localStorage) for instant auth on restarts.
- **Idle cleanup** — browser contexts of finished conversations are automatically closed after 10 minutes of inactivity.
- **Fresh-chat fallback** — when no identity key is provided, each request starts an isolated conversation with the full history rebuilt.
- **Header interception** via Playwright route handling to capture session tokens (bx-ua, bx-v, bx-umidtoken, cookies).

---

## Architecture Overview

```
OpenCode (or any OpenAI client)
  │  POST /v1/chat/completions
  │  Headers: x-opencode-chat-key (optional)
  ▼
QwenProxy
  │  Translates request → Qwen Web API format
  │  Uses isolated BrowserContext per chat-key
  │  Sends delta-only when reusing a Qwen chat
  ▼
chat.qwen.ai (via Playwright-intercepted session)
```

---

## Prerequisites

- Node.js >= 20
- Playwright browsers

```bash
npm install
npx playwright install chromium
```

---

## Configuration

Create a `.env` file in the project root:

```env
PORT=3000
API_KEY=your_secret_api_key           # optional; protects /v1/*
QWEN_EMAIL=your_email@example.com     # required for auto-login
QWEN_PASSWORD=your_password
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `QWEN_EMAIL` | Yes (unless using `npm run login`) | Qwen account email |
| `QWEN_PASSWORD` | Yes (unless using `npm run login`) | Qwen account password |
| `API_KEY` | No | Bearer token for `/v1/*` endpoints |
| `PORT` | No | Server port (default: 3000) |

---

## Usage

### Start the server

```bash
npm start
```

On first start, if `QWEN_EMAIL` and `QWEN_PASSWORD` are set, the proxy **logs in automatically** and saves the auth state to `qwen_profile/auth.json`. Subsequent restarts reuse this saved state.

To see detailed logs:

```bash
DEBUG_QWEN_PROXY=1 npm start
```

### Manual login (one-time)

```bash
npm run login
```

Opens a browser window. Log in to Qwen, then close it. The auth state is saved to `qwen_profile/auth.json`.

### Docker

```bash
docker-compose up -d
```

---

## API

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint.

**Request body** (JSON):

```json
{
  "model": "qwen3.6-plus",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "tools": [...]
}
```

**Models:**
- `qwen3.6-plus` — with thinking
- `qwen3.6-plus-no-thinking` — thinking disabled

---

## OpenCode Integration

To use QwenProxy from [OpenCode](https://opencode.ai), add a provider in `opencode.json`:

```json
{
  "provider": {
    "qwen-local": {
      "name": "Qwen Local",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1"
      },
      "models": {
        "qwen3.6-plus": {
          "name": "Qwen3.6 Plus",
          "limit": { "context": 1000000, "output": 65536 }
        }
      }
    }
  }
}
```

---

### Plugin: Session‑Aware Chat Keys (recommended)

For optimal isolation, install the official plugin that injects an identity header (`x-opencode-chat-key`) into every provider request. This tells the proxy to keep **one dedicated browser session per session+agent+model**.

#### 1. Install the npm package

```bash
npm install -g @justmpm/qwen-chat-key
```

*Or install locally in your OpenCode config directory.*

#### 2. Register

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@justmpm/qwen-chat-key"
  ]
}
```

No local file needed — OpenCode loads the plugin directly from npm.

#### 3. Restart OpenCode

Plugins are loaded at startup only.

### What the plugin sends

When using the `qwen-local` provider, the plugin injects these headers:

| Header | Value |
|---|---|
| `x-opencode-chat-key` | `sha256(v1|<session>|<agent>|<provider>|<model>)` |
| `x-opencode-session-id` | OpenCode session ID |
| `x-opencode-agent` | Agent name (e.g. `nexus`, `worker`) |
| `x-opencode-provider-id` | `qwen-local` |
| `x-opencode-model-id` | Model ID (e.g. `qwen3.6-plus`) |

---

## How Session Isolation Works

### Without the plugin (fresh chat per request)

Each call gets a brand‑new Qwen chat. The proxy rebuilds the whole conversation from `body.messages`. No history leaks between unrelated calls.

### With the plugin (isolated browser contexts)

Every unique `x-opencode-chat-key` gets its **own Playwright `BrowserContext`** (separate cookies, localStorage, page, lock, and header cache). Because each context is fully isolated in the Playwright process:

- Multiple agents can call the proxy **concurrently** without interfering with each other
- Each context maintains its own Qwen session — when the conversation history matches, only new messages (the delta) are sent
- Idle contexts are automatically closed after **10 minutes** of inactivity (`reapIdle()`)
- If a chat key is reused after cleanup, a fresh context is created transparently

```
same sessionID + same agent + same model  →  same BrowserContext  →  same Qwen chat
different sessionID                        →  different BrowserContext
different agent                            →  different BrowserContext
no header                                  →  fresh chat per request (full history rebuilt)
```

---

## Idle Cleanup

Browser contexts that are not the default one are **automatically closed** when they have been unused for **10 minutes**. This prevents runaway browser processes.

The cleanup runs:
- Before every `getQwenHeaders()` call
- When explicitly triggered via the exported test helpers

In the terminal, you'll see:

```
[Playwright] Reaped idle context "abc123..." (idle for 720s)
[Playwright] Idle cleanup: 1 context(s) closed, 3 remaining.
```

---

## Testing

```bash
npm test
```

The test suite includes:

- **17 integration tests** — conversation history, streaming, caching, hybrid retry, JSON error handling, and tool parsing
- **8 idle‑cleanup unit tests** — coverage for context lifecycle, idle removal, default context protection, mixed idle/recent, idempotency, and re-creation after cleanup

---

## Project Structure

```
.
├── src/
│   ├── index.ts               # Server entry, middleware, startup
│   ├── login.ts               # Standalone login script (npm run login)
│   ├── routes/
│   │   └── chat.ts            # POST /v1/chat/completions handler
│   ├── services/
│   │   ├── playwright.ts      # Playwright context pool, header interception, auth
│   │   └── qwen.ts            # Qwen API integration, hybrid delta logic
│   ├── tools/
│   │   ├── registry.ts        # Tool execution and result formatting
│   │   ├── parser.ts          # Streaming JSON tool call parser
│   │   └── types.ts           # Tool type definitions
│   └── utils/
│       ├── types.ts           # OpenAI-compatible request/response types
│       └── json.ts            # Robust JSON extraction
├── qwen_profile/              # Playwright profile (auth.json, browser data)
├── test/
│   ├── advanced.test.ts       # Integration tests (history, retry, streaming)
│   ├── idle.test.ts           # Idle-cleanup unit tests
│   └── index.test.ts          # Basic health / models / streaming tests
├── .env.example
├── docker-compose.yml
└── Dockerfile
```

---

## API Key Protection

If `API_KEY` is set in `.env`, all `/v1/*` endpoints require the header:

```
Authorization: Bearer <your_secret_api_key>
```

Requests without a valid token receive a `401 Unauthorized` response.

---

## Environment Variable Reference

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `API_KEY` | — | Bearer token for API protection |
| `QWEN_EMAIL` | — | Qwen account email (auto-login) |
| `QWEN_PASSWORD` | — | Qwen account password |
| `DEBUG_QWEN_PROXY` | — | Set to `1` for verbose request/response logs |

---

## License

ISC

---

## Disclaimer

This project is provided strictly for **educational and research purposes**.

The authors do not encourage or endorse:
- Misuse
- Unauthorized automation
- Abuse of third-party services
- Violations of platform Terms of Service

Users are solely responsible for how they use this software, including compliance with applicable laws, regulations, and service agreements.

Use at your own risk.
