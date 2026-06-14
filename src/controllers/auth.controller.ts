import { Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { env } from '../config/env';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const REFRESH_COOKIE = 'refreshToken';

// Cookie is httpOnly (JS can't read it → XSS can't steal it), SameSite=strict
// (not sent cross-site → CSRF mitigation), secure in production (HTTPS only),
// and path-scoped to /api/v1/auth so it's only sent to refresh/logout, not on
// every API request.
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path:     '/api/v1/auth',
  };
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...refreshCookieOptions(), expires: expiresAt });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

export const authController = {
  register: asyncHandler(async (req: Request, res: Response) => {
    const result = await authService.register(req.body);
    sendSuccess(res, result, 201);
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const { accessToken, refreshToken, refreshExpiresAt, user } = await authService.login(req.body);
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    sendSuccess(res, { accessToken, user });
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const { accessToken, refreshToken, refreshExpiresAt, user } =
      await authService.refresh(req.cookies?.[REFRESH_COOKIE]);
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    sendSuccess(res, { accessToken, user });
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    sendSuccess(res, { loggedOut: true });
  }),
};
