import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { TooManyRequestsError } from '../errors/AppError';

export const MINUTE = 60_000;
export const HOUR   = 60 * MINUTE;

// Sliding-window-counter rate limiter, evaluated atomically in Redis.
//
// Two fixed sub-windows (current + previous) are kept; the trailing-window count
// is estimated as current + previous * (fraction of the current window not yet
// elapsed). This approximates a true sliding window at a fraction of the cost of
// a sliding log (which stores every request timestamp). Redis-backed so the
// limit is global across instances — in-memory counters would give an attacker
// N× the limit with N instances.
const SCRIPT = `
local cur     = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev    = tonumber(redis.call('GET', KEYS[2]) or '0')
local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local weight  = (window - elapsed) / window
local estimated = cur + prev * weight
if estimated >= limit then
  return 1
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return 0
`;

type RateLimitOptions = {
  name:    string;                       // namespace for the key
  limit:   number;                       // max requests per window
  windowMs: number;                      // window size
  key:     (req: Request) => string;     // identity to bucket on (IP / userId)
};

// Common identity extractors.
export const byIp   = (req: Request) => req.ip ?? 'unknown';
export const byUser = (req: Request) => req.user?.userId ?? req.ip ?? 'unknown';

export function rateLimit(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const id          = opts.key(req);
      const now         = Date.now();
      const windowStart = Math.floor(now / opts.windowMs) * opts.windowMs;
      const elapsed     = now - windowStart;
      const curKey      = `rl:${opts.name}:${id}:${windowStart}`;
      const prevKey     = `rl:${opts.name}:${id}:${windowStart - opts.windowMs}`;

      let blocked: unknown;
      try {
        blocked = await redis.eval(SCRIPT, 2, curKey, prevKey, opts.limit, opts.windowMs, elapsed);
      } catch (err) {
        // Redis unreachable → fail OPEN. A rate limiter must never take down the
        // API; better to briefly under-protect than to reject everyone.
        logger.warn('Rate limiter degraded — allowing request', { name: opts.name, error: (err as Error).message });
        return next();
      }

      if (blocked === 1) {
        const retryAfter = Math.ceil((opts.windowMs - elapsed) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return next(new TooManyRequestsError(`Rate limit exceeded — retry in ${retryAfter}s`));
      }
      next();
    })().catch(next);
  };
}

// ── Preconfigured tiers (per the Phase 3 plan) ───────────────────────────────
export const globalLimiter   = rateLimit({ name: 'global',   limit: 100, windowMs: MINUTE, key: byIp });
export const loginLimiter    = rateLimit({ name: 'login',    limit: 5,   windowMs: MINUTE, key: byIp });
export const registerLimiter = rateLimit({ name: 'register', limit: 3,   windowMs: HOUR,   key: byIp });
export const bookingLimiter  = rateLimit({ name: 'booking',  limit: 10,  windowMs: MINUTE, key: byUser });
