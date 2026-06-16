import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

// Single Redis client for the process (same pattern as the Prisma client).
//
// enableOfflineQueue:false + a bounded retry means that if Redis is down,
// commands reject immediately instead of queueing forever — the cache layer
// catches those rejections and falls back to the database. Caching is an
// optimisation, never a correctness dependency.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue:   false,
  retryStrategy:        (times) => Math.min(times * 200, 2000),
});

let loggedDown = false;
redis.on('error', (err) => {
  // Throttle: ioredis emits on every reconnect attempt. Log the first failure.
  if (!loggedDown) {
    logger.warn('Redis unavailable — serving uncached', { error: err.message });
    loggedDown = true;
  }
});
redis.on('ready', () => {
  loggedDown = false;
  logger.info('Redis connected');
});
