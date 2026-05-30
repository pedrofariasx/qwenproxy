# QwenProxy compatibility notes

Base URL padrao para todos os clientes:

```txt
http://127.0.0.1:3000/v1
```

Se `API_KEY` estiver configurado no `.env`, use essa mesma chave no cliente como API key. Se `API_KEY` estiver vazio, use qualquer valor dummy quando o cliente exigir uma chave.

## Rotas por tipo de cliente

| Cliente | Melhor rota | Observacao |
| --- | --- | --- |
| OpenCode | `/v1/chat/completions` | Usa `@ai-sdk/openai-compatible` para provider customizado. |
| `@ai-sdk/openai-compatible` | `/v1/chat/completions` | Configure `baseURL`, `apiKey`, modelo e `includeUsage` quando quiser usage no stream. |
| Zed | `/v1/chat/completions` | Configure em `language_models.openai_compatible`. Declare capabilities do modelo. |
| Pi | `/v1/chat/completions` | Configure provider com `api: "openai-completions"` e `baseUrl`. |
| Kilo CLI / Kilo Code | `/v1/chat/completions` | Selecione provider OpenAI Compatible, Base URL, API Key e Model. |
| Codex CLI | `/v1/responses` | Use `wire_api = "responses"` para preservar itens/tool calls do Responses API. |

## Contrato HTTP que o proxy aceita

- `POST /v1/chat/completions` aceita `messages` no padrao OpenAI. Tambem aceita `input` ou `prompt` como fallback e converte para uma mensagem de usuario.
- `POST /v1/responses` aceita `input` no padrao Responses. Tambem aceita `messages` e converte para itens de entrada.
- Tools no Chat Completions sao normalizadas para `type: "function"` com `function.name`, `description` e `parameters`.
- Tools no Responses sao permissivas: `function`, `custom`, `namespace` e descritores hospedados como `web_search_preview` passam pelo HTTP sem quebrar o cliente. O proxy so transforma em tool call aquilo que consegue emular no Qwen.
- Erros de `/v1/*` usam formato OpenAI-compatible: `{ "error": { "message", "type", "param", "code" } }`.
- `OPTIONS` em `/v1/*` retorna CORS simples para SDKs e clientes que fazem preflight.
- `GET /v1/models` e `GET /v1/models/:model` retornam objetos `model` com `capabilities`, `context_window`, `supports_tools` e variantes `-no-thinking`.

## OpenCode

Fonte lida: `https://opencode.ai/docs/providers`.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "qwenproxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "QwenProxy",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "{env:QWENPROXY_API_KEY}"
      },
      "models": {
        "qwen3.6-plus": {
          "name": "Qwen 3.6 Plus",
          "limit": {
            "context": 128000,
            "output": 8192
          }
        },
        "qwen3.6-plus-no-thinking": {
          "name": "Qwen 3.6 Plus no thinking",
          "limit": {
            "context": 128000,
            "output": 8192
          }
        }
      }
    }
  }
}
```

## Vercel AI SDK

Fonte lida: `https://ai-sdk.dev/v7/providers/openai-compatible-providers`.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const qwenproxy = createOpenAICompatible({
  name: "qwenproxy",
  baseURL: "http://127.0.0.1:3000/v1",
  apiKey: process.env.QWENPROXY_API_KEY || "dummy",
  includeUsage: true
});
```

Use o modelo:

```ts
const model = qwenproxy("qwen3.6-plus");
```

## Zed

Fonte lida: `https://zed.dev/docs/ai/llm-providers`.

`settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "QwenProxy": {
        "api_url": "http://127.0.0.1:3000/v1",
        "available_models": [
          {
            "name": "qwen3.6-plus",
            "display_name": "QwenProxy Qwen 3.6 Plus",
            "max_tokens": 128000,
            "max_output_tokens": 8192,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": false,
              "prompt_cache_key": false
            }
          },
          {
            "name": "qwen3.6-plus-no-thinking",
            "display_name": "QwenProxy Qwen 3.6 Plus no thinking",
            "max_tokens": 128000,
            "max_output_tokens": 8192,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": false,
              "prompt_cache_key": false
            }
          }
        ]
      }
    }
  }
}
```

## Pi

Fonte lida: `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md`.

Modelo/provider customizado:

```json
{
  "providers": {
    "qwenproxy": {
      "baseUrl": "http://127.0.0.1:3000/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": true,
        "maxTokensField": "max_tokens",
        "supportsStore": false
      },
      "models": [
        {
          "id": "qwen3.6-plus",
          "name": "QwenProxy Qwen 3.6 Plus",
          "contextWindow": 128000,
          "maxTokens": 8192,
          "reasoning": true,
          "input": ["text"]
        }
      ]
    }
  }
}
```

Uso esperado:

```bash
pi --model qwenproxy/qwen3.6-plus "explique o projeto"
```

## Kilo CLI / Kilo Code

Fonte lida: `https://github.com/kilo-org/kilo/blob/main/packages/kilo-docs/pages/ai-providers/openai-compatible.md`.

Configure como OpenAI Compatible:

```txt
API Provider: OpenAI Compatible
Base URL: http://127.0.0.1:3000/v1
API Key: valor de API_KEY, ou dummy se API_KEY estiver vazio
Model: qwen3.6-plus
```

Se usar configuracao em JSON:

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "model": "qwen3.6-plus",
  "provider": {
    "openai-compatible": {
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "{env:QWENPROXY_API_KEY}"
      }
    }
  }
}
```

## Codex CLI

Fonte lida: `https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md`.

Codex deve usar a rota Responses:

```toml
[model_providers.qwenproxy]
name = "QwenProxy"
base_url = "http://127.0.0.1:3000/v1"
wire_api = "responses"
env_key = "QWENPROXY_API_KEY"

[profiles.qwenproxy]
model_provider = "qwenproxy"
model = "qwen3.6-plus"
```

Uso:

```bash
codex -p qwenproxy
```

## Debug no terminal

Para ver chamadas sem afogar o terminal:

```bash
npm run start:debug
```

Para ver prompt e deltas parciais:

```bash
npm run start:debug:full
```

Variaveis:

```env
QWENPROXY_DEBUG=off        # off | basic | full | raw
QWENPROXY_DEBUG_MAX_CHARS=1200
QWENPROXY_DEBUG_SHOW_PROMPT=false
```

O modo `basic` mostra rota, cliente, modelo, quantidade de mensagens, tools, conta usada, resumo da resposta e erro traduzido. O modo `full` tambem mostra preview do prompt e resposta parcial. O modo `raw` e para investigacao pesada.

Clientes podem enviar o header abaixo para aparecer com nome bonito no terminal:

```http
X-QwenProxy-Client: OpenCode
```

## Persistencia de contas

As contas do CLI ficam em SQLite:

```env
QWENPROXY_DATA_DIR=./data
# QWENPROXY_DB_PATH=./data/qwenproxy.db
USER_DATA_DIR=./qwen_profiles/global
QWENPROXY_PROFILES_DIR=./qwen_profiles
```

Se existir `accounts.json`, o proxy migra automaticamente para `data/qwenproxy.db`, ativa WAL e renomeia o arquivo antigo para `accounts.json.bak`.
