import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { runWithContext } from '../utils/requestContext';

// Seeds a requestId for the whole request (echoed in the X-Request-Id response
// header so a client/log can be cross-referenced), runs the rest of the chain
// inside the async context, and logs one line on completion with method, path,
// status, and duration. Mounted first so every downstream log line is correlated.
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();

  runWithContext({ requestId }, () => {
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const meta = {
        method:     req.method,
        path:       req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };
      // 5xx already gets a full error log in errorHandler; here we log the
      // completion line at a severity matching the status class.
      if (res.statusCode >= 500)      logger.error('request completed', meta);
      else if (res.statusCode >= 400) logger.warn('request completed', meta);
      else                            logger.info('request completed', meta);
    });

    next();
  });
}
