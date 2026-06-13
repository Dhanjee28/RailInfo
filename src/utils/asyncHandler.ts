import { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps an async route handler so any rejected promise is forwarded to next(err).
// This keeps controllers free of try/catch — they throw (or let services throw)
// and the global errorHandler takes it from there.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
