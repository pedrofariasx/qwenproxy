import { Hono } from 'hono'
import { config } from '../core/config.js'
import { getBasicHeaders } from '../services/playwright.js'
import { loadAccounts } from '../core/accounts.js'
import { getAccountCooldownInfo } from '../core/account-manager.js'
import { cache } from '../cache/memory-cache.js'
import { syncModelContextWindows } from '../core/model-registry.js'

const app = new Hono()

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
      data: [
        ...models.map((model: any) => ({
          id: model.id,
          name: model.name,
          object: 'model',
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        })),
        ...models.map((model: any) => ({
          id: `${model.id}-no-thinking`,
          name: `${model.name} (No Thinking)`,
          object: 'model',
          owned_by: model.owned_by,
          created: model.info?.created_at || Date.now(),
          context_window: model.info?.meta?.max_context_length,
          capabilities: model.info?.meta?.capabilities,
        })),
      ],
    }

    syncModelContextWindows(formatted.data)
    await cache.set(cacheKey, formatted, 300)
    
    return c.json(formatted)
  } catch (error: any) {
    console.error('Error fetching models:', error)
    return c.json({ error: error.message }, 500)
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
        data: [
          ...rawModels.map((model: any) => ({
            id: model.id,
            name: model.name,
            object: 'model',
            owned_by: model.owned_by,
            created: model.info?.created_at || Date.now(),
            context_window: model.info?.meta?.max_context_length,
            capabilities: model.info?.meta?.capabilities,
          })),
          ...rawModels.map((model: any) => ({
            id: `${model.id}-no-thinking`,
            name: `${model.name} (No Thinking)`,
            object: 'model',
            owned_by: model.owned_by,
            created: model.info?.created_at || Date.now(),
            context_window: model.info?.meta?.max_context_length,
            capabilities: model.info?.meta?.capabilities,
          })),
        ],
      }

      syncModelContextWindows(formatted.data)
      await cache.set(cacheKey, formatted, 300)
      models = formatted.data
    }

    const model = models.find((m: any) => m.id === modelId)
    
    if (!model) {
      return c.json({ error: 'Model not found' }, 404)
    }
    
    return c.json(model)
  } catch (error: any) {
    console.error('Error fetching model:', error)
    return c.json({ error: error.message }, 500)
  }
})

export { app }
