export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

export function handleErrorBody(peekText: string, status: number): never {
  try {
    const errorJson = JSON.parse(peekText);
    if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
    }
    if (errorJson && (errorJson.success === false || errorJson.error)) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || errorJson.error?.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      let errStatus = 502;
      if (code === 'RateLimited') errStatus = 429;
      else if (code === 'Unauthorized' || code === 'Unauthenticated' || details.toLowerCase().includes('token has expired') || details.toLowerCase().includes('please log in again')) errStatus = 401;
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, errStatus);
    }
  } catch (e) {
    if (e instanceof QwenUpstreamError || e instanceof RetryableQwenStreamError) throw e;
  }
  throw new Error(`Qwen returned status ${status}: ${peekText.slice(0, 500)}`);
}

export function handleJsonErrorBody(errText: string): never {
  try {
    const errorJson = JSON.parse(errText);
    if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
    }
    if (errorJson?.success === false) {
      const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
      const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
      const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
      let status: number;
      if (code === 'RateLimited') status = 429;
      else if (code === 'Not_Found') status = 404;
      else if (code === 'Unauthorized' || code === 'Unauthenticated' || details.toLowerCase().includes('token has expired') || details.toLowerCase().includes('please log in again')) status = 401;
      else status = 502;
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
    }
    if (errorJson?.data?.details?.includes('is not exist') || errorJson?.data?.details?.includes('not exist') || errorJson.data?.details?.includes('does not exist')) {
      throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
    }
  } catch (e) {
    if (e instanceof RetryableQwenStreamError || e instanceof QwenUpstreamError) throw e;
  }
  throw new Error(`Qwen JSON error: ${errText.slice(0, 500)}`);
}
