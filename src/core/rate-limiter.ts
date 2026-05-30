import type { Context } from 'hono';

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private headerKey: string;

  constructor(max = 60, windowMs = 60000, headerKey = 'x-forwarded-for') {
    this.max = max;
    this.windowMs = windowMs;
    this.headerKey = headerKey;
    setInterval(() => this.cleanup(), 60000).unref();
  }

  check(key: string): { allowed: boolean; remaining: number; reset: number } {
    const now = Date.now();
    let timestamps = this.windows.get(key) || [];
    timestamps = timestamps.filter(t => now - t < this.windowMs);

    if (timestamps.length >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        reset: timestamps[0] + this.windowMs,
      };
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.max - timestamps.length,
      reset: now + this.windowMs,
    };
  }

  middleware() {
    const self = this;
    return async (c: Context, next: () => Promise<void>) => {
      const key = c.req.header(self.headerKey)
        || c.req.header('x-forwarded-for')
        || c.req.header('x-real-ip')
        || 'unknown';

      const result = self.check(key);

      c.header('X-RateLimit-Limit', String(self.max));
      c.header('X-RateLimit-Remaining', String(result.remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(result.reset / 1000)));

      if (!result.allowed) {
        return c.json(
          { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } },
          429 as any,
        );
      }

      await next();
    };
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.windows.entries()) {
      const filtered = timestamps.filter(t => now - t < this.windowMs);
      if (filtered.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, filtered);
      }
    }
  }
}
