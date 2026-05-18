# QwenProxy

A local API proxy that routes requests to **Qwen (chat.qwen.ai)** models via Playwright browser automation. OpenAI-compatible interface with tool execution, reasoning support, and session persistence.

---

## Requirements

- Node.js 20+
- npm 9+

## Quick Start

```bash
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy
npm install
npm start
```

## Configuration

Create a `.env` file in the project root:

```env
PORT=3000
API_KEY=your-secret-key
QWEN_EMAIL=your@email.com
QWEN_PASSWORD=your-password
BROWSER=chromium
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start server (Chromium) |
| `npm run start:firefox` | Start with Firefox |
| `npm run login` | Manual login |

## API

### Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer your-key
```

### Models

```http
GET /v1/models
```

### Example (OpenAI SDK)

```typescript
const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'sk-test'
});

const completion = await client.chat.completions.create({
  model: 'qwen-plus',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## Supported Models

- `qwen-plus` (default, with reasoning)
- `qwen-plus-no-thinking` (without reasoning block)
- `qwen-max`, `qwen-turbo`, etc. (depends on account)

## Project Structure

```
src/
├── index.ts         # Server entry point
├── routes/chat.ts   # Chat completion handler
├── services/
│   ├── qwen.ts      # Qwen API integration
│   └── playwright.ts # Browser automation
├── tools/
│   ├── parser.ts    # Tool call parsing
│   ├── executor.ts  # Tool execution
│   └── registry.ts  # Tool registry
└── login.ts         # Authentication script
```

## License

ISC
