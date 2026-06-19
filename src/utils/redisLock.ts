import crypto from 'crypto';
import { redis } from '../config/redis';
import { ConflictError } from '../errors/AppError';

// Only delete the key if we still own it (value == our token). Prevents deleting
// a lock that already expired and was re-acquired by another booker.
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRedisLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();

  if (!(await acquire(key, token, ttlMs))) {
    throw new ConflictError('LOCK_TIMEOUT', 'Could not acquire booking lock — please retry');
  }

  try {
    return await fn();
  } finally {
    // Best-effort release; the TTL is the backstop if this fails.
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch {
      /* ignore — lock will expire on its own */
    }
  }
}

// Spin-acquire: SET key token NX PX ttl, retrying briefly because the lock is
// coarse (whole class) and short contention is expected.
async function acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (res === 'OK') return true;
    await sleep(Math.random() * 50 + 20);
  }
  return false;
}
