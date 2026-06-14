import { Request, Response } from 'express';
import { adminService } from '../services/admin.service';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

export const adminController = {
  createStation: asyncHandler(async (req: Request, res: Response) => {
    const station = await adminService.createStation(req.body);
    sendSuccess(res, { station }, 201);
  }),

  createTrain: asyncHandler(async (req: Request, res: Response) => {
    const train = await adminService.createTrain(req.body);
    sendSuccess(res, { train }, 201);
  }),

  updateTrain: asyncHandler(async (req: Request, res: Response) => {
    const train = await adminService.updateTrain(String(req.params.trainNumber), req.body);
    sendSuccess(res, { train });
  }),

  createCoach: asyncHandler(async (req: Request, res: Response) => {
    const coach = await adminService.createCoach(req.body);
    sendSuccess(res, { coach }, 201);
  }),
};
