# QwenProxy

Proxy API local compativel com OpenAI que roteia chamadas para o **Qwen (chat.qwen.ai)** via Playwright. O projeto suporta Chat Completions, Responses, streaming, tools, reasoning, multi-conta com rotacao, persistencia em SQLite/WAL e debug legivel no terminal.

[![CI](https://github.com/pedrofariasx/qwenproxy/actions/workflows/ci.yml/badge.svg)](https://github.com/pedrofariasx/qwenproxy/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.12-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

## Features

- **OpenAI compatible**: `/v1/chat/completions`, `/v1/responses`, `/v1/models` e erros no formato OpenAI.
- **Compatibilidade com agentes**: presets e ajustes para OpenCode, Zed, Codex, Pi, Kilo e `@ai-sdk/openai-compatible`.
- **Multi-conta**: contas Qwen em SQLite com round-robin, cooldown por rate limit e fallback para contas em `.env`.
- **SQLite WAL**: banco em `data/qwenproxy.db`, migracao automatica de `accounts.json` e shutdown fechando conexao.
- **Debug legivel**: modos `off`, `basic`, `full` e `raw` para ver request, modelo, tools, conta, resposta e erro traduzido.
- **Tools e reasoning**: suporte a tool calls locais e modelos com pensamento quando disponivel.
- **Docker ready**: volumes separados para banco (`data/`) e perfis do navegador (`qwen_profiles/`).

## Instalacao

```bash
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy
npm install
npx playwright install
```

Com Docker:

```bash
docker-compose up -d
```

## Configuracao

Crie um `.env` baseado em `.env.example`:

```env
PORT=3000
API_KEY=sua-chave-local

# Conta unica via .env, opcional.
QWEN_EMAIL=seu-email@example.com
QWEN_PASSWORD=sua-senha

# Persistencia
QWENPROXY_DATA_DIR=./data
USER_DATA_DIR=./qwen_profiles/global
QWENPROXY_PROFILES_DIR=./qwen_profiles

# Debug
QWENPROXY_DEBUG=off
QWENPROXY_DEBUG_MAX_CHARS=1200
QWENPROXY_DEBUG_SHOW_PROMPT=false
```

## Contas

As contas adicionadas pelo CLI ficam em SQLite (`data/qwenproxy.db`). Se existir um `accounts.json` antigo, ele e migrado na primeira abertura do banco e renomeado para `accounts.json.bak`.

```bash
npm run login
npm run login:chrome
npm run login:firefox
npm run login:edge
```

O menu permite adicionar conta com credenciais, adicionar via login manual no navegador, remover contas salvas no SQLite e iniciar login em todas.

Tambem da para usar contas por `.env`:

```env
QWEN_EMAIL_1=primeira@example.com
QWEN_PASSWORD_1=senha1
QWEN_EMAIL_2=segunda@example.com
QWEN_PASSWORD_2=senha2
```

Contas de `.env` aparecem como `env` no gerenciador e nao sao removidas pelo CLI; remova do `.env`.

## Uso

```bash
npm start
npm run start:chrome
npm run start:firefox
npm run start:edge
```

Rotas publicadas:

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/metrics` | Metricas Prometheus |
| GET | `/v1/models` | Lista modelos no formato OpenAI |
| GET | `/v1/models/:model` | Detalhe de um modelo |
| POST | `/v1/chat/completions` | Chat Completions |
| POST | `/v1/responses` | Responses API |
| POST | `/v1/chat/responses` | Alias de Responses |
| POST | `/v1/responses/stop` | Cancela stream ativo |
| POST | `/v1/chat/responses/stop` | Alias de cancelamento |

## Debug

Para diagnostico humano, suba com:

```bash
npm run start:debug
```

Isso mostra cliente detectado, rota, modelo, stream, quantidade de mensagens, tools, conta escolhida, resposta final e erro traduzido com proximo passo pratico.

Para ver preview da entrada e do prompt enviado ao Qwen:

```bash
QWENPROXY_DEBUG=full QWENPROXY_DEBUG_SHOW_PROMPT=true npm start
```

| Modo | O que mostra |
|---|---|
| `off` | Sem debug extra |
| `basic` | Resumo limpo de request, resposta e erro |
| `full` | Inclui preview de entrada, prompt e deltas parciais |
| `raw` | Mais verboso, para investigacao curta |

Presets reais de OpenCode, Zed, Codex, Pi, Kilo e AI SDK ficam em [`docs/compatibility.md`](docs/compatibility.md).

## Docker

`docker-compose.yml` persiste o banco e as sessoes:

```yaml
services:
  qwenproxy:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./qwen_profiles:/app/qwen_profiles
```

| Volume | Conteudo |
|---|---|
| `./data` | SQLite (`qwenproxy.db`, `-wal`, `-shm`) |
| `./qwen_profiles` | Cookies e sessoes do Playwright |

## Estrutura

```txt
src/
  api/                 servidor Hono e modelos
  routes/              Chat Completions e Responses
  core/
    accounts.ts        CRUD e merge env/SQLite
    database.ts        SQLite, WAL e migracao accounts.json
    debug-console.ts   debug legivel
    openai-compat.ts   normalizacao e erros OpenAI
  services/            Playwright e chamadas Qwen
  tools/               parser, registry e executor
```

## Troubleshooting

| Problema | O que fazer |
|---|---|
| `Missing or invalid Authorization header` | Defina `Authorization: Bearer <API_KEY>` ou deixe `API_KEY` vazio no `.env` |
| Porta 3000 em uso | Troque `PORT` no `.env` |
| Navegador nao abre | Rode `npx playwright install` |
| Sessao expirada | Rode `npm run login` e refaca login |
| Rate limit | Adicione mais contas pelo CLI ou espere o cooldown |
| Banco antigo nao aparece | Verifique `data/qwenproxy.db` e se `accounts.json.bak` foi criado |
| Debug insuficiente | Rode `QWENPROXY_DEBUG=full QWENPROXY_DEBUG_SHOW_PROMPT=true npm start` |

## Disclaimer

Este projeto e fornecido para fins educacionais e de pesquisa. Use por sua conta e risco e respeite os termos da plataforma Qwen.
