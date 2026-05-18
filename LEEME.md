# QwenProxy

Proxy local que conecta tus aplicaciones con los modelos **Qwen (chat.qwen.ai)** mediante Playwright. Compatible con la API de OpenAI, herramientas locales y modo razonamiento.

---

## Requisitos

- Node.js 20+
- npm 9+

## Instalación rápida

```bash
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy
npm install
npm start
```

## Configuración

Crea un archivo `.env` en la raíz:

```env
PORT=3000
API_KEY=tu-clave-secreta
QWEN_EMAIL=tu@email.com
QWEN_PASSWORD=tu-contraseña
BROWSER=chromium
```

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm start` | Iniciar servidor (Chromium) |
| `npm run start:firefox` | Iniciar con Firefox |
| `npm run login` | Inicio de sesión manual |

## API

### Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer tu-clave
```

### Modelos disponibles

```http
GET /v1/models
```

### Health Check

```http
GET /health
```

### Ejemplo con OpenAI SDK

```typescript
const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'sk-test'
});

const respuesta = await client.chat.completions.create({
  model: 'qwen-plus',
  messages: [{ role: 'user', content: 'Hola' }]
});
```

## Modelos compatibles

- `qwen-plus` — por defecto, con razonamiento
- `qwen-plus-no-thinking` — sin bloque de pensamiento
- `qwen-max`, `qwen-turbo` — según disponibilidad de la cuenta

## Estructura del proyecto

```
src/
├── index.ts         # Punto de entrada
├── routes/chat.ts   # Manejador de chat
├── services/
│   ├── qwen.ts      # Integración con Qwen
│   └── playwright.ts # Automatización del navegador
├── tools/
│   ├── parser.ts    # Parseo de tool calls
│   ├── executor.ts  # Ejecución de herramientas
│   └── registry.ts  # Registro de herramientas
└── login.ts         # Script de autenticación
```

## Posibles mejoras

1. **El texto entre tool calls se pierde** — si el modelo dice algo antes de llamar una herramienta, ese texto se descarta. Revisar `src/tools/parser.ts`.
2. **Errores de Qwen no se detectan en streaming** — el error payload de Qwen se parsea sobre el buffer incompleto, no sobre las líneas SSE completas. Ver `src/routes/chat.ts`.
3. **Sin shutdown graceful** — al hacer Ctrl+C, el proceso de Playwright queda abierto. Faltan handlers SIGINT/SIGTERM en `src/index.ts`.
4. **Tokens cacheados siempre en 0** — `cached_tokens: 0` está hardcodeado, no refleja la realidad. Ver `src/routes/chat.ts`.
5. **Tipos duplicados** — tres archivos de tipos con interfaces similares: `src/utils/types.ts`, `src/tools/types.ts`, `src/types/openai.ts`.
6. **`tool_choice: 'none'` ignorado** — solo se maneja el objeto `{ type: 'function', function: { name } }`. Los strings `'auto'`, `'none'`, `'required'` no funcionan.
7. **Variables muertas** — `inThinkingState`, `thinkingFragments` y `currentAppendPath` están declaradas pero nunca se usan en `src/routes/chat.ts`.
8. **Detección de entry point frágil** — la comparación `process.argv[1]` puede fallar con tsx en Windows por diferencias de rutas.

## Aviso

Proyecto educativo. Úsalo bajo tu propia responsabilidad.
