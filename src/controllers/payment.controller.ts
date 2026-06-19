import { Request, Response } from 'express';
import { paymentService } from '../services/payment.service';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

export const paymentController = {
  pay: asyncHandler(async (req: Request, res: Response) => {
    const idempotencyKey = req.header('Idempotency-Key');
    const result = await paymentService.pay(req.user!.userId, req.body.pnr, idempotencyKey);
    sendSuccess(res, result);
  }),
};
