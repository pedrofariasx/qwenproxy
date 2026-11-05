import { Hono } from 'hono'
import { config } from '../core/config.js'
import { getBasicHeaders } from '../services/playwright.js'
import { loadAccounts } from '../core/accounts.js'
import { getAccountCooldownInfo } from '../core/account-manager.js'
import { cache } from '../cache/memory-cache.js'
import { syncModelContextWindows } from '../core/model-registry.js'
import crypto from 'crypto'
import { openaiError } from '../utils/openai.js'

const app = new Hono()

function buildCatalog(rawModels: any[]): any[] {
  const capabilitiesOf = (model: any): string[] | undefined => {
    const caps = model?.info?.meta?.capabilities
    return Array.isArray(caps) ? caps.filter((c: any) => typeof c === 'string') : undefined
  }
  const entry = (model: any, id: string, name?: string) => {
    const rawCreated = Number(model.info?.created_at)
    const created = rawCreated > 10_000_000_000 ? Math.floor(rawCreated / 1000) : rawCreated || Math.floor(Date.now() / 1000)
    return {
    id,
    name,
    object: 'model',
    owned_by: model.owned_by || 'qwen',
    created,
    context_window: model.info?.meta?.max_context_length,
    capabilities: capabilitiesOf(model),
    }
  }
  return rawModels.map((model: any) => entry(model, model.id, model.name))
}

/**
 * Fetches the full Qwen model catalog with a dedicated admin-side cache, so
 * the admin dashboard can show every available model without coupling to the
 * public /v1/models cache keys. Thinking mode is controlled per-request via
 * `reasoning_effort` (or the legacy -thinking/-no-thinking suffixes).
 */
export async function fetchFullModelCatalog(): Promise<any[]> {
  const cacheKey = 'models:full-catalog'
  const cached = await cache.get<any>(cacheKey)
  if (cached?.data) return cached.data

  let accountId: string | undefined
  try {
    const accounts = loadAccounts()
    const account = accounts.find(a => !getAccountCooldownInfo(a.id))
    if (account) {
      accountId = account.id
    }
  } catch (e) {
    console.warn('Failed to retrieve account for model catalog:', e)
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders(accountId)
  const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Connection': 'keep-alive',
      'Referer': `${config.qwen.baseUrl}/c/demo`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': userAgent,
      'X-Request-Id': crypto.randomUUID(),
      'source': 'web',
      'bx-v': bxV,
      'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Timezone': new Date().toString(),
      'Cookie': cookie,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`)
  }

  const data = await response.json()
  const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []

  const formatted = {
    object: 'list',
    data: buildCatalog(models),
  }

  syncModelContextWindows(formatted.data)
  await cache.set(cacheKey, formatted, 300)

  return formatted.data
}

app.get('/v1/models', async (c) => {
  try {
    let accountId: string | undefined
    try {
      const accounts = loadAccounts()
      const account = accounts.find(a => !getAccountCooldownInfo(a.id))
      if (account) {
        accountId = account.id
      }
    } catch (e) {
      console.warn('Failed to retrieve account for models endpoint:', e)
    }

    const cacheKey = `models:${accountId || 'global'}` as any
    const cached = await cache.get<any>(cacheKey)
    if (cached) {
      return c.json(cached)
    }

    const { cookie, userAgent, bxV } = await getBasicHeaders(accountId)
    const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Connection': 'keep-alive',
        'Referer': `${config.qwen.baseUrl}/c/demo`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': userAgent,
        'X-Request-Id': crypto.randomUUID(),
        'source': 'web',
        'bx-v': bxV,
        'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Timezone': new Date().toString(),
        'Cookie': cookie,
      },
    })
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }
    
    const data = await response.json()
    
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    
    const formatted = {
      object: 'list',
      data: buildCatalog(models),
    }

    syncModelContextWindows(formatted.data)
    await cache.set(cacheKey, formatted, 300)
    
    return c.json(formatted)
  } catch (error: any) {
    console.error('Error fetching models:', error)
    const response = openaiError(error.message, 502, 'upstream_error')
    return c.json(response.body, response.status)
  }
})

app.get('/v1/models/:model', async (c) => {
  try {
    const modelId = c.req.param('model')

    let accountId: string | undefined
    try {
      const accounts = loadAccounts()
      const account = accounts.find(a => !getAccountCooldownInfo(a.id))
      if (account) {
        accountId = account.id
      }
    } catch (e) {
      console.warn('Failed to retrieve account for model endpoint:', e)
    }

    const cacheKey = `models:${accountId || 'global'}` as any
    const formattedList = await cache.get<any>(cacheKey)
    let models = formattedList?.data || []

    if (models.length === 0) {
      const { cookie, userAgent, bxV } = await getBasicHeaders(accountId)
      const response = await fetch(`${config.qwen.baseUrl}/api/models`, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Connection': 'keep-alive',
          'Referer': `${config.qwen.baseUrl}/c/demo`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': userAgent,
          'X-Request-Id': crypto.randomUUID(),
          'source': 'web',
          'bx-v': bxV,
          'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Timezone': new Date().toString(),
          'Cookie': cookie,
        },
      })
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`)
      }
      
      const data = await response.json()
      const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
      
      const formatted = {
        object: 'list',
        data: buildCatalog(rawModels),
      }

      syncModelContextWindows(formatted.data)
      await cache.set(cacheKey, formatted, 300)
      models = formatted.data
    }

    const model = models.find((m: any) => m.id === modelId)
    
    if (!model) {
      const response = openaiError('The model does not exist', 404, 'invalid_request_error', 'model', 'model_not_found')
      return c.json(response.body, response.status)
    }
    
    return c.json(model)
  } catch (error: any) {
    console.error('Error fetching model:', error)
    const response = openaiError(error.message, 502, 'upstream_error')
    return c.json(response.body, response.status)
  }
})

export { app }
