import { QwenUpstreamError, RetryableQwenStreamError } from '../services/qwen.ts'

/**
 * Sanitizes an error for API responses:
 * - Known errors (QwenUpstreamError, RetryableQwenStreamError) keep their message.
 * - Unknown errors in production are replaced with "Internal server error".
 * - In development the original message (plus stack in `details`) is included.
 */
export function sanitizeError(
  err: unknown,
  isProd: boolean,
): { message: string; details?: string } {
  if (err instanceof QwenUpstreamError || err instanceof RetryableQwenStreamError) {
    return { message: err.message }
  }

  if (isProd) {
    return { message: 'Internal server error' }
  }

  const message = err instanceof Error ? err.message : String(err)
  return { message, details: err instanceof Error ? err.stack : undefined }
}
