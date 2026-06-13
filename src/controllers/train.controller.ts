import { Request, Response } from 'express';
import { trainService } from '../services/train.service';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

// After validate() runs, req.query values are coerced by Zod to plain strings.
// We extract them with a typeof guard since Express types query values as string | string[].
function qs(val: unknown): string {
  return typeof val === 'string' ? val : String(val);
}
function qsOpt(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

export const trainController = {
  search: asyncHandler(async (req: Request, res: Response) => {
    const source      = qs(req.query.source);
    const destination = qs(req.query.destination);
    const date        = qs(req.query.date);
    const result = await trainService.search(source, destination, date);
    sendSuccess(res, result);
  }),

  getDetails: asyncHandler(async (req: Request, res: Response) => {
    // @types/express@5 widens route params to string | string[]; cast is safe —
    // route params are always single strings, never arrays.
    const trainNumber = req.params.trainNumber as string;
    const date = qsOpt(req.query.date);
    const result = await trainService.getDetails(trainNumber, date);
    sendSuccess(res, result);
  }),
};
