const modelContextWindows: Record<string, number> = {
  'qwen3.7-plus': 1000000,
  'qwen3.7-max': 1000000,
  'qwen3.6-plus': 1000000,
  'qwen3.6-plus-preview': 1000000,
  'qwen3.6-max-preview': 262144,
  'qwen3.6-27b': 262144,
  'qwen3.6-35b-a3b': 262144,
  'qwen3.5-plus': 1000000,
  'qwen3.5-flash': 1000000,
  'qwen3.5-omni-plus': 262144,
  'qwen3.5-omni-flash': 262144,
  'qwen3.5-max-2026-03-08': 262144,
  'qwen3.5-397b-a17b': 262144,
  'qwen3.5-122b-a10b': 262144,
  'qwen3.5-27b': 262144,
  'qwen3.5-35b-a3b': 262144,
  'qwen3-max-2026-01-23': 262144,
  'qwen3-coder-plus': 1048576,
  'qwen3-vl-plus': 262144,
  'qwen3-omni-flash-2025-12-01': 65536,
  'qwen-plus-2025-07-28': 131072,
  'qwen-latest-series-invite-beta-v24': 262144,
  'qwen-latest-series-invite-beta-v16': 1000000,
}

const modelTokenDivisors: Record<string, number> = {
  'qwen3.7-max': 3.5,
  'qwen3.6-max-preview': 3.5,
  'qwen3.5-max-2026-03-08': 3.5,
  'qwen3-max-2026-01-23': 3.5,
  'qwen-latest-series-invite-beta-v24': 3.5,
  'qwen3.7-plus': 3.5,
  'qwen3.6-plus': 3.5,
  'qwen3.6-plus-preview': 3.5,
  'qwen3.5-plus': 3.5,
  'qwen-plus-2025-07-28': 3.5,
  'qwen-latest-series-invite-beta-v16': 3.5,
  'qwen3.5-flash': 3.2,
  'qwen3.5-omni-plus': 3.0,
  'qwen3.5-omni-flash': 3.0,
  'qwen3-omni-flash-2025-12-01': 3.0,
  'qwen3.5-397b-a17b': 3.2,
  'qwen3.5-122b-a10b': 3.2,
  'qwen3.6-35b-a3b': 3.2,
  'qwen3.5-35b-a3b': 3.2,
  'qwen3.6-27b': 3.2,
  'qwen3.5-27b': 3.2,
  'qwen3-coder-plus': 3.8,
  'qwen3-vl-plus': 3.5,
}

const defaultContextWindow = 131072
const defaultTokenDivisor = 3.5
export const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024

export function setModelContextWindow(modelId: string, contextWindow: number): void {
  modelContextWindows[modelId] = contextWindow
}

export function getModelContextWindow(modelId?: string): number {
  if (!modelId) return defaultContextWindow
  const baseId = modelId.replace('-no-thinking', '').replace('-thinking', '')
  return modelContextWindows[baseId] ?? defaultContextWindow
}

export function getModelTokenDivisor(modelId?: string): number {
  if (!modelId) return defaultTokenDivisor
  const baseId = modelId.replace('-no-thinking', '').replace('-thinking', '')
  return modelTokenDivisors[baseId] ?? defaultTokenDivisor
}

export function syncModelContextWindows(models: Array<{ id: string; context_window?: number }>): void {
  for (const m of models) {
    if (m.context_window) {
      modelContextWindows[m.id] = m.context_window
    }
  }
}
