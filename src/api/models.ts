import { Hono } from 'hono'
import { config } from '../core/config.js'
import { getBasicHeaders } from '../services/playwright.js'
import {
  normalizeModelList,
  normalizeModelObject,
  openAIErrorBody,
} from '../core/openai-compat.js'
import { syncModelContextWindows } from '../core/model-registry.js'

const app = new Hono()

app.get('/v1/models', async (c) => {
  try {
    const { cookie, userAgent, bxV } = await getBasicHeaders()
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
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'Timezone': new Date().toString(),
        'Cookie': cookie,
      },
    })
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }
    
    const data = await response.json()
    
    const formatted = normalizeModelList(data)
    syncModelContextWindows(formatted.data)
    
    return c.json(formatted)
  } catch (error: any) {
    console.error('Error fetching models:', error)
    return c.json(openAIErrorBody(error.message, 500, { code: 'models_fetch_failed' }), 500)
  }
})

app.get('/v1/models/:model', async (c) => {
  try {
    const modelId = c.req.param('model')
    const baseModelId = modelId.replace('-no-thinking', '')
    const { cookie, userAgent, bxV } = await getBasicHeaders()
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
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'Timezone': new Date().toString(),
        'Cookie': cookie,
      },
    })
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }
    
    const data = await response.json()
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    const model = models.find((m: any) => m.id === baseModelId)
    
    if (!model) {
      return c.json(openAIErrorBody(`Model not found: ${modelId}`, 404, {
        code: 'model_not_found',
        param: 'model',
      }), 404)
    }
    
    return c.json(normalizeModelObject(model, modelId))
  } catch (error: any) {
    console.error('Error fetching model:', error)
    return c.json(openAIErrorBody(error.message, 500, { code: 'model_fetch_failed' }), 500)
  }
})

export { app }
