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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
