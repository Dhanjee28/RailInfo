import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type Target = 'body' | 'query' | 'params';

// Returns an Express middleware that validates req[target] against the Zod schema.
// On failure: responds 400 with VALIDATION_ERROR + per-field details.
// On success: replaces req[target] with the parsed (coerced + defaulted) data, then calls next().
// Controllers see only valid, typed input — no try/catch needed.
export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const details = result.error.errors.map((e) => ({
        field: e.path.length > 0 ? e.path.join('.') : 'root',
        message: e.message,
      }));
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
        },
      });
      return;
    }

    // Replace with the parsed output so downstream code gets coerced types
    // (e.g., z.coerce.number() on a query param turns "3" into 3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[target] = result.data;
    next();
  };
}
