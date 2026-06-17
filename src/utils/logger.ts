import pino from 'pino';
import { env } from '../config/env';
import { getRequestId } from './requestContext';

// Structured JSON logger. The mixin pulls requestId from the per-request
// AsyncLocalStorage context, so every line is automatically correlated to its
// request with zero plumbing. redact strips anything sensitive that might slip
// into a log payload — passwords and tokens must never be logged.
const defaultLevel =
  env.NODE_ENV === 'production' ? 'info' :
  env.NODE_ENV === 'test'       ? 'silent' :  // keep unit-test output clean
                                  'debug';

const base = pino({
  level: env.LOG_LEVEL ?? defaultLevel,
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
  redact: {
    paths: [
      'password', 'passwordHash', '*.password', '*.passwordHash',
      'token', 'refreshToken', 'accessToken', '*.token', '*.refreshToken', '*.accessToken',
      'req.headers.authorization', 'headers.authorization', 'authorization',
    ],
    censor: '[REDACTED]',
  },
});

// Keep the original (message, meta) signature so existing call sites are
// unchanged. pino's native arg order is (mergeObject, message) — we flip it.
export const logger = {
  info:  (msg: string, meta?: unknown) => base.info(meta ?? {}, msg),
  warn:  (msg: string, meta?: unknown) => base.warn(meta ?? {}, msg),
  error: (msg: string, meta?: unknown) => base.error(meta ?? {}, msg),
  debug: (msg: string, meta?: unknown) => base.debug(meta ?? {}, msg),
};
