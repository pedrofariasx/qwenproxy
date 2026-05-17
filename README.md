# QwenProxy

Proxy API local compatível com OpenAI que roteia requisições para os modelos do **Qwen (chat.qwen.ai)** via automação de navegador com Playwright. Oferece suporte a execução de ferramentas, modo de pensamento (reasoning) e persistência de sessão.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.0-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.60-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## ✨ Features

- **OpenAI API Compatible**: Interface compatível com `/v1/chat/completions` e `/v1/models`.
- **Reasoning Support**: Suporte completo ao modo de pensamento (thinking) dos modelos Qwen.
- **Tool Execution**: Sistema de execução de ferramentas locais integrado ao fluxo do chat.
- **Auto-login on startup** (com credenciais no `.env`)
- **Anti-detection browser flags** (bypass bot detection)
- **Session Persistence**: Login persistente com armazenamento de perfil do navegador em `qwen_profile/`.
- **Network Visibility**: Exibe URLs local e de rede (IP) ao iniciar o servidor.
- **Browser Selection**: Escolha entre Chrome, Firefox, Edge ou Chromium para execução.
- **Docker Ready**: Deploy simplificado com suporte a Docker e Docker Compose.
- Ready for Dokploy / Coolify / Docker deployment

---

## 🏗️ Arquitetura

```mermaid
graph TD
    Client[Cliente OpenAI/SDK] -->|HTTP| Proxy[QwenProxy]
    Proxy -->|/v1/chat/completions| Handler[Chat Handler]
    Handler --> Qwen[chat.qwen.ai]
    Handler --> Playwright[Playwright Service]
    Playwright --> Browser[Browser Instance]
    Handler --> Tools[Tools Executor]
    Tools --> Registry[Tool Registry]
    
    subgraph "Configuração"
        Env[.env] --> Proxy
        Profile[qwen_profile/] --> Playwright
    end
```

---

## 📋 Pré-requisitos

| Dependência | Versão Mínima | Instalação |
|------------|--------------|-----------|
| Node.js | v22.x | [nvm](https://github.com/nvm-sh/nvm) |
| npm | v9.x | Incluído com Node.js |
| Playwright | - | `npx playwright install` |
| Docker (opcional) | v24.x | [Docker Docs](https://docs.docker.com/get-docker/) |

---

## 🚀 Instalação

### Via npm

```bash
# Clonar repositório
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy

# Instalar dependências
npm install

# Instalar browsers do Playwright
npx playwright install
```

### Via Docker

```bash
# Iniciar containers
docker-compose up -d
```

---

## ⚙️ Configuração

Crie o arquivo `.env` na raiz do projeto:

```env
# Porta do servidor (default: 3000)
PORT=3000

# Chave de API para proteger os endpoints (opcional)
API_KEY=sua-chave-secreta-aqui

# Credenciais Qwen (para login automático)
QWEN_EMAIL=seu-email@exemplo.com
QWEN_PASSWORD=sua-senha-aqui

# Navegador padrão (chromium, firefox, chrome, edge)
BROWSER=chromium
```

| Variável | Descrição |
|----------|-----------|
| **API_KEY** | Se definida, requisições a `/v1/*` devem incluir `Authorization: Bearer sua-chave` |
| **QWEN_EMAIL** | Email para login automático no startup |
| **QWEN_PASSWORD** | Senha para login automático no startup |
| **BROWSER** | Navegador padrão: `chromium`, `firefox`, `chrome`, `edge` |

---

## 📡 Uso e Comandos

### Docker / Dokploy / Coolify (Recomendado)

O Dockerfile usa a imagem oficial do Playwright com browsers pré-instalados.

```bash
# Local Docker
docker-compose up -d

# Ou deploy direto em Dokploy/Coolify usando o Dockerfile incluído
```

O servidor estará disponível em `http://localhost:3000` (ou seu domínio VPS).

### Inicialização do Servidor

```bash
# Iniciar com o navegador padrão (Chromium)
npm start

# Iniciar com navegadores específicos
npm run start:chrome
npm run start:firefox
npm run start:edge
```

Ao iniciar, o console exibirá:
```txt
🚀 QwenProxy started!
- Local:   http://localhost:3000
- Network: http://192.168.1.10:3000

Available Routes:
- [GET] /health
- [POST] /v1/chat/completions
- [GET] /v1/models
```

### Autenticação de Sessão (Login)

#### Com Auto-Login (Recomendado)

Defina `QWEN_EMAIL` e `QWEN_PASSWORD` no `.env`, depois:

```bash
npm start
```

O servidor fará login automaticamente no startup e preservará a sessão.

#### Sem Credenciais (Login Manual)

Se não fornecer credenciais no `.env`, faça login manualmente uma vez:

```bash
npm run login
# Ou com browser específico
npm run login:firefox
npm run login:chrome
npm run login:edge
```

Isso abrirá uma janela do navegador. Faça login e feche-a. Depois inicie o servidor:

```bash
npm start
```

---

## 📡 API Reference

### Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sua-chave
```

**Modelos Suportados**:
- `qwen-plus`: Modelo padrão com raciocínio habilitado.
- `qwen-plus-no-thinking`: Versão sem o bloco de pensamento.
- `qwen-max`, `qwen-turbo`, etc. (conforme disponibilidade na conta).

### `GET /v1/models`

Retorna os modelos Qwen disponíveis.

### `GET /health`

Health check para orquestração de containers.

---

## 💻 Exemplos de Integração

### OpenAI SDK (Node.js)

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.API_KEY || 'sk-no-key-required'
});

const completion = await openai.chat.completions.create({
  model: 'qwen-plus',
  messages: [{ role: 'user', content: 'Explique como funciona o Playwright.' }]
});

console.log(completion.choices[0].message.content);
```

---

## 📁 Estrutura do Projeto

```
qwenproxy/
├── src/
│   ├── index.ts              # Entry point e servidor Hono
│   ├── login.ts              # Script de autenticação
│   ├── routes/
│   │   └── chat.ts           # Handler compatível com OpenAI
│   ├── services/
│   │   ├── qwen.ts           # Integração com a API do Qwen
│   │   └── playwright.ts     # Automação de navegador
│   ├── tools/
│   │   ├── executor.ts       # Execução de ferramentas
│   │   └── registry.ts       # Registro de tools
│   └── utils/                # Utilitários
├── qwen_profile/             # Armazenamento da sessão (gitignored)
├── Dockerfile                # Configuração Docker otimizada
├── docker-compose.yml        # Docker Compose local
└── package.json              # Scripts e dependências
```

---

## 🔍 Troubleshooting

- **Endereço em uso**: Verifique se a porta `3000` está livre ou altere o `PORT` no `.env`.
- **Erro de Navegador**: Se um navegador não abrir, certifique-se de que ele está instalado (`npx playwright install`).
- **Sessão Expirada**: Execute `npm run login` novamente para renovar os cookies.
- **Falha de Login Automático**: Verifique se `QWEN_EMAIL` e `QWEN_PASSWORD` estão corretos no `.env`.

---

## ⚠️ Disclaimer

> Este projeto é fornecido estritamente para fins educacionais e de pesquisa.

Os autores não incentivam ou endossam:
- Violação dos Termos de Serviço da plataforma Qwen.
- Automação não autorizada em larga escala.
- Uso para atividades maliciosas.

**Use por sua conta e risco.**
