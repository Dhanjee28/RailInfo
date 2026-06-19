import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).default(10),
  // Refresh token lifetime in days; the access token stays short (JWT_EXPIRES_IN).
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // Overrides the default level (info in prod, debug otherwise). e.g. 'warn', 'silent'.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // Set to 'false' to disable rate limiting (used when load-testing the booking
  // path itself — the limiter is orthogonal to the concurrency we're stressing).
  RATE_LIMIT_ENABLED: z.string().default('true').transform((v) => v.toLowerCase() !== 'false'),
  // Which concurrency-control strategy the booking flow uses (Phase 4). Lets us
  // benchmark the three approaches by flipping one env var.
  LOCK_STRATEGY: z.enum(['pessimistic', 'optimistic', 'redis']).default('pessimistic'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
