# QwenProxy

Un proxy local que conecta tus apps con los modelos de **Qwen (chat.qwen.ai)** usando Playwright. Compatible con la API de OpenAI, herramientas locales y modo de razonamiento.

---

## Requisitos

- Node.js 20+
- npm 9+
- Playwright (se instala solo con `npm install`)

## Instalación

```bash
git clone https://github.com/pedrofariasx/qwenproxy.git
cd qwenproxy
npm install
npm start
```

## Configuración

Crea un archivo `.env`:

```env
PORT=3000
API_KEY=tu-clave-secreta
QWEN_EMAIL=tu@email.com
QWEN_PASSWORD=tu-contraseña
BROWSER=chromium
```

## Uso

```bash
npm start           # Iniciar servidor (Chromium por defecto)
npm run start:firefox  # Usar Firefox
npm run login        # Login manual si no usas credenciales
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat con el modelo |
| GET | `/v1/models` | Lista de modelos disponibles |
| GET | `/health` | Estado del servidor |

## Ejemplo con OpenAI SDK

```typescript
const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'sk-test'
});

const response = await client.chat.completions.create({
  model: 'qwen-plus',
  messages: [{ role: 'user', content: 'Hola' }]
});
```

## Estructura

```
src/
├── index.ts        # Servidor principal
├── routes/chat.ts  # Endpoint de chat
├── services/       # Integración con Qwen y Playwright
├── tools/          # Sistema de herramientas
└── login.ts        # Autenticación
```

## Disclaimer

Este proyecto es solo para fines educativos. El uso es bajo tu responsabilidad.