import type { ContentfulStatusCode } from 'hono/utils/http-status'

export interface OpenAIError {
  message: string
  type: string
  param: string | null
  code: string | null
}

export function openaiError(
  message: string,
  status: number,
  type = status === 401 ? 'authentication_error' : 'invalid_request_error',
  param: string | null = null,
  code: string | null = null,
): { body: { error: OpenAIError }; status: ContentfulStatusCode } {
  return {
    body: { error: { message, type, param, code } },
    status: status as ContentfulStatusCode,
  }
}
