import { Request, Response } from 'express';
import { stationService } from '../services/station.service';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

export const stationController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    const stations = await stationService.list();
    sendSuccess(res, { stations });
  }),
};
