import { redis } from '../config/redis';
import { logger } from './logger';

// Cache-aside read:
//   1. try the cache; on hit, return the parsed value
//   2. on miss, run the loader, store the result with a TTL, return it
//
// Every Redis call is wrapped — if Redis is unreachable the request still
// succeeds straight from the loader (the DB). Null/undefined loader results are
// NOT cached, so a one-off miss (e.g. unknown train number) can't poison the
// cache with a negative entry that outlives a later create.
export async function cacheAside<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn('Cache read failed', { key, error: (err as Error).message });
  }

  const value = await loader();

  if (value !== null && value !== undefined) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('Cache write failed', { key, error: (err as Error).message });
    }
  }

  return value;
}

// Explicit invalidation — used when a write makes a cached key stale.
export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn('Cache delete failed', { keys, error: (err as Error).message });
  }
}
