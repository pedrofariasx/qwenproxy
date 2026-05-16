# QwenProxy

Local proxy server that interfaces with Qwen (chat.qwen.ai) using browser automation via Playwright.  
Provides an OpenAI-compatible API for chat interactions and tool execution.

---

## Features

- OpenAI-compatible API endpoints for chat completion
- Reasoning/Thinking support
- Tool execution support
- **Auto-login on startup** (with credentials in `.env`)
- **Anti-detection browser flags** (bypass bot detection)
- Persistent browser session with login state
- Built with Hono and TypeScript
- Ready for Dokploy / Coolify / Docker deployment

---

## Prerequisites

- Node.js v22 or later
- Playwright browsers (auto-installed via Dockerfile)

---

## Installation

```bash
npm install
npx playwright install
```

---

## Configuration

Create a `.env` file in the project root:

```env
PORT=3000
API_KEY=your_secret_api_key
QWEN_EMAIL=your_email@example.com
QWEN_PASSWORD=your_password
```

| Variable | Description |
|----------|-------------|
| **API_KEY** | If set, requests to `/v1/*` must include `Authorization: Bearer your_secret_api_key` |
| **QWEN_EMAIL** | Email for automatic login on startup |
| **QWEN_PASSWORD** | Password for automatic login on startup |

---

## Usage

### Docker / Dokploy / Coolify (Recommended)

The Dockerfile uses the official Playwright image with pre-installed browsers.

```bash
# Local Docker
docker-compose up -d

# Or deploy directly to Dokploy/Coolify using the included Dockerfile
```

The server will be available at `http://localhost:3000` (or your VPS domain).

### Local Execution

#### With Auto-Login (Recommended)

Set `QWEN_EMAIL` and `QWEN_PASSWORD` in `.env`, then:

```bash
npm start
```

The server will automatically log in on startup and preserve the session.

#### Without Credentials (Manual Login)

If you don't provide credentials in `.env`, you must log in manually once:

```bash
npm run login
```

This will open a browser window. Log in and then close it. Then start the server:

```bash
npm start
```

The server runs by default at:

```txt
http://localhost:3000
```

---

## Testing

```bash
npm test
```

---

## API Endpoints

### `POST /v1/chat/completions`

OpenAI-compatible endpoint.

**Note**: If `API_KEY` is configured, include the Bearer token in your request headers.

#### Models
- `qwen3.6-plus` (with thinking)
- `qwen3.6-plus-no-thinking`

### `GET /v1/models`

Returns available Qwen models.

### `GET /health`

Health check endpoint for container orchestration.

---

## Project Structure

```txt
.
├── src/
│   ├── index.ts           # Server entry
│   ├── login.ts           # Manual login CLI
│   ├── routes/            # API routes
│   ├── services/          # Qwen & Playwright services
│   ├── tools/             # Tool execution
│   └── utils/             # Utilities
├── qwen_profile/          # Browser profile storage
├── Dockerfile             # Optimized for Dokploy/Coolify
└── docker-compose.yml     # Local Docker setup
```

---

## License

ISC

---

# Disclaimer

This project is provided strictly for educational and research purposes.

The authors do not encourage or endorse:

- Misuse
- Unauthorized automation
- Abuse of third-party services
- Violations of platform Terms of Service

Users are solely responsible for how they use this software, including compliance with applicable laws, regulations, and service agreements.

This repository is intended to demonstrate concepts related to:

- Browser automation
- Session management
- OpenAI-compatible runtime architectures

Use at your own risk.