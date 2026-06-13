import { Response } from 'express';

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ success: true, data });
}

export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
): void {
  res.status(statusCode).json({ success: false, error: { code, message } });
}
