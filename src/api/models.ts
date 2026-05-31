import crypto from 'node:crypto'
import { Hono } from 'hono'
import { config } from '../core/config.js'
import { getBasicHeaders } from '../services/playwright.js'
import { Logger } from '../core/logger.js'

const logger = new Logger('info', 'Models')
const app = new Hono()

interface ModelCatalogEntry {
  id: string
  name?: string
  owned_by?: string
  info?: {
    created_at?: number
    meta?: {
      max_context_length?: number
      capabilities?: string[]
    }
  }
}

/** Static fallback models returned when Playwright isn't initialized yet. */
const STATIC_MODELS: ModelCatalogEntry[] = [
  { id: 'qwen-turbo-latest', name: 'Qwen Turbo', owned_by: 'qwen', info: { meta: { max_context_length: 131072, capabilities: ['chat', 'tool_calling'] } } },
  { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', owned_by: 'qwen', info: { meta: { max_context_length: 131072, capabilities: ['chat', 'thinking', 'tool_calling'] } } },
  { id: 'qwen3.7-coder', name: 'Qwen 3.7 Coder', owned_by: 'qwen', info: { meta: { max_context_length: 131072, capabilities: ['chat', 'code', 'tool_calling'] } } },
  { id: 'qwen-vl-max', name: 'Qwen VL Max', owned_by: 'qwen', info: { meta: { max_context_length: 32768, capabilities: ['chat', 'vision'] } } },
  { id: 'qwen2.5-72b-instruct', name: 'Qwen 2.5 72B', owned_by: 'qwen', info: { meta: { max_context_length: 32768, capabilities: ['chat', 'tool_calling'] } } },
  { id: 'qwen2.5-32b-instruct', name: 'Qwen 2.5 32B', owned_by: 'qwen', info: { meta: { max_context_length: 32768, capabilities: ['chat', 'tool_calling'] } } },
  { id: 'qwen2.5-14b-instruct', name: 'Qwen 2.5 14B', owned_by: 'qwen', info: { meta: { max_context_length: 32768, capabilities: ['chat'] } } },
  { id: 'qwen2.5-7b-instruct', name: 'Qwen 2.5 7B', owned_by: 'qwen', info: { meta: { max_context_length: 32768, capabilities: ['chat'] } } },
]

class ModelsUnavailableError extends Error {
  statusCode = 503
}

let lastLiveModelFetch = 0
let cachedLiveModels: ModelCatalogEntry[] | null = null
const LIVE_MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** Reset the model cache — used in tests to prevent cross-test pollution. */
export function resetModelCache(): void {
  cachedLiveModels = null
  lastLiveModelFetch = 0
}

async function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
  // If we've cached live models recently, use them
  if (cachedLiveModels && Date.now() - lastLiveModelFetch < LIVE_MODEL_CACHE_TTL) {
    return cachedLiveModels
  }

  let headers

  try {
    headers = await getBasicHeaders()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Fallback to static models when Playwright is not initialized
    if (message.includes('not initialized') || message.includes('No Playwright session')) {
      logger.info('Playwright not initialized — returning static model catalog fallback')
      return STATIC_MODELS
    }
    throw new ModelsUnavailableError(`Nenhuma sessão autenticada do Qwen está disponível para /v1/models: ${message}`)
  }

  try {
    const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Connection': 'keep-alive',
        'Referer': `${config.qwen.baseUrl}/c/demo`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': headers.userAgent,
        'X-Request-Id': crypto.randomUUID(),
        'source': 'web',
        'bx-v': headers.bxV,
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'Timezone': new Date().toString(),
        'Cookie': headers.cookie,
      },
    })

    if (!response.ok) {
      logger.warn(`Failed to fetch live models: ${response.status} — using static fallback`)
      return STATIC_MODELS
    }

    const data = await response.json()
    const liveModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    if (liveModels.length > 0) {
      cachedLiveModels = liveModels
      lastLiveModelFetch = Date.now()
      return liveModels
    }
    return STATIC_MODELS
  } catch (err) {
    logger.warn(`Live model fetch error: ${err instanceof Error ? err.message : String(err)} — using static fallback`)
    return STATIC_MODELS
  }
}

function formatModelList(models: ModelCatalogEntry[]) {
  return {
    object: 'list',
    data: [
      ...models.map((model) => ({
        id: model.id,
        name: model.name,
        object: 'model',
        owned_by: model.owned_by,
        created: model.info?.created_at || Math.floor(Date.now() / 1000),
        context_window: model.info?.meta?.max_context_length,
        capabilities: model.info?.meta?.capabilities,
      })),
      ...models.map((model) => ({
        id: `${model.id}-no-thinking`,
        name: `${model.name} (No Thinking)`,
        object: 'model',
        owned_by: model.owned_by,
        created: model.info?.created_at || Math.floor(Date.now() / 1000),
        context_window: model.info?.meta?.max_context_length,
        capabilities: model.info?.meta?.capabilities,
      })),
    ],
  }
}

function formatSingleModel(modelId: string, model: ModelCatalogEntry) {
  const isNoThinking = modelId.endsWith('-no-thinking')

  return {
    id: modelId,
    name: isNoThinking ? `${model.name} (No Thinking)` : model.name,
    object: 'model',
    owned_by: model.owned_by,
    created: model.info?.created_at || Math.floor(Date.now() / 1000),
    context_window: model.info?.meta?.max_context_length,
    capabilities: model.info?.meta?.capabilities,
  }
}

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchModelCatalog()
    return c.json(formatModelList(models))
  } catch (error: any) {
    const statusCode = error instanceof ModelsUnavailableError ? error.statusCode : 500
    logger.error('Error fetching models: ' + (error instanceof Error ? error.message : String(error)))
    return c.json({ error: error.message }, statusCode as any)
  }
})

app.get('/v1/models/:model', async (c) => {
  try {
    const modelId = c.req.param('model')
    const baseModelId = modelId.replace('-no-thinking', '')
    const models = await fetchModelCatalog()
    const model = models.find((entry) => entry.id === baseModelId)

    if (!model) {
      return c.json({ error: 'Model not found' }, 404)
    }

    return c.json(formatSingleModel(modelId, model))
  } catch (error: any) {
    const statusCode = error instanceof ModelsUnavailableError ? error.statusCode : 500
    logger.error('Error fetching model: ' + (error instanceof Error ? error.message : String(error)))
    return c.json({ error: error.message }, statusCode as any)
  }
})

export { app }
