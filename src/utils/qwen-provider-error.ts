import { isOverloadMessage } from './overload-detector.js';
import { isDailyQuotaAssistantMessage } from './qwen-quota-message.js';

export interface QwenProviderError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  dailyQuota: boolean;
  providerCode?: string;
}

export function parseQwenProviderError(payload: any): QwenProviderError | null {
  const raw = payload?.error ?? payload?.choices?.[0]?.delta?.error ?? (payload?.success === false ? payload.data ?? payload : null);
  if (!raw) return null;
  const details = typeof raw === 'string' ? raw : raw.details ?? raw.message ?? payload?.message;
  const message = typeof details === 'string' ? details.slice(0, 500) : 'Qwen returned an upstream error.';
  const providerCode = typeof raw?.code === 'string' ? raw.code.slice(0, 80) : undefined;
  if (isDailyQuotaAssistantMessage(message)) return { code: 'RateLimited', message, status: 429, retryable: false, dailyQuota: true, providerCode };
  if (isOverloadMessage(message)) return { code: 'UpstreamOverloaded', message, status: 503, retryable: true, dailyQuota: false, providerCode };
  return { code: 'UpstreamError', message, status: providerCode === 'RateLimited' ? 429 : providerCode === 'Not_Found' ? 404 : 502, retryable: false, dailyQuota: false, providerCode };
}

export function emptyQwenResponseError(): QwenProviderError {
  return { code: 'EmptyResponse', message: 'Qwen ended the response without assistant content or tool calls.', status: 502, retryable: true, dailyQuota: false };
}

export function parseQwenProviderBody(raw: string): QwenProviderError | null {
  if (!raw.trim()) return null;
  const unexpected: QwenProviderError = { code: 'UpstreamError', message: 'Qwen returned an unexpected non-SSE response.', status: 502, retryable: false, dailyQuota: false };
  try {
    return parseQwenProviderError(JSON.parse(raw)) ?? unexpected;
  } catch { return unexpected; }
}

export function qwenErrorBody(error: QwenProviderError) {
  return { error: { message: error.message, type: error.status === 429 ? 'rate_limit_error' : 'api_error', code: error.code, ...(error.providerCode ? { provider_code: error.providerCode } : {}) } };
}
