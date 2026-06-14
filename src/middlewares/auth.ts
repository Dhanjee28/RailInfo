import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { ForbiddenError, UnauthorizedError } from '../errors/AppError';

interface JwtPayload {
  userId: string;
  role: Role;
}

// Verifies the Bearer token and attaches { userId, role } to req.user.
// Throws UnauthorizedError — which the global errorHandler turns into a 401 —
// so every protected route is one-liner: router.get('/foo', requireAuth, handler).
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing or malformed Authorization header'));
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.user = { userId: payload.userId, role: payload.role };
    next();
  } catch {
    // Covers TokenExpiredError, JsonWebTokenError, NotBeforeError
    next(new UnauthorizedError('Token is invalid or expired'));
  }
}

// Gate a route to a specific role. Must be stacked AFTER requireAuth so req.user
// is populated. Trusts the signed JWT's role claim — the token is tamper-proof,
// so no DB round-trip is needed for the common case. (If immediate role-revocation
// mattered, you'd re-verify from the DB here; the 15-min access-token window is
// the accepted tradeoff, same as we made for token revocation.)
export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (req.user.role !== role) {
      next(new ForbiddenError(`Requires ${role} role`));
      return;
    }
    next();
  };
}
