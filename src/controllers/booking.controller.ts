import { Request, Response } from 'express';
import { z } from 'zod';
import { bookingService } from '../services/booking.service';
import { bookingHistoryQuerySchema, createBookingSchema } from '../validators/booking.validators';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

type HistoryQuery    = z.infer<typeof bookingHistoryQuerySchema>;
type CreateBookingBody = z.infer<typeof createBookingSchema>;

export const bookingController = {
  getHistory: asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = req.query as unknown as HistoryQuery;
    const result = await bookingService.getHistory(req.user!.userId, page, limit);
    sendSuccess(res, result);
  }),

  getDetail: asyncHandler(async (req: Request, res: Response) => {
    const pnr = req.params.pnr as string;
    const result = await bookingService.getDetail(req.user!.userId, pnr);
    sendSuccess(res, result);
  }),

  create: asyncHandler(async (req: Request, res: Response) => {
    const data = req.body as CreateBookingBody;
    const result = await bookingService.create(req.user!.userId, data);
    sendSuccess(res, result, 201);
  }),

  cancel: asyncHandler(async (req: Request, res: Response) => {
    const pnr = req.params.pnr as string;
    const result = await bookingService.cancel(req.user!.userId, pnr);
    sendSuccess(res, result);
  }),
};
