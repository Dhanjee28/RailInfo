import { ClassType } from '@prisma/client';
import { z } from 'zod';
import { adminRepository } from '../repositories/admin.repository';
import { cacheDel } from '../utils/cache';
import { STATIONS_CACHE_KEY } from './station.service';
import { BadRequestError, ConflictError, NotFoundError } from '../errors/AppError';
import {
  createStationSchema,
  createTrainSchema,
  updateTrainSchema,
  createCoachSchema,
} from '../validators/admin.validators';

type CreateStationInput = z.infer<typeof createStationSchema>;
type CreateTrainInput   = z.infer<typeof createTrainSchema>;
type UpdateTrainInput   = z.infer<typeof updateTrainSchema>;
type CreateCoachInput   = z.infer<typeof createCoachSchema>;

// API class strings → Prisma enum names (mirrors booking.service)
const API_CLASS_TO_PRISMA: Record<string, ClassType> = {
  SL: 'SL', '3A': 'THREE_A', '2A': 'TWO_A', '1A': 'FIRST_A',
};

export const adminService = {
  async createStation(data: CreateStationInput) {
    const existing = await adminRepository.findStationByCode(data.code);
    if (existing) throw new ConflictError('STATION_EXISTS', `Station ${data.code} already exists`);
    const station = await adminRepository.createStation(data);
    await cacheDel(STATIONS_CACHE_KEY); // station list is now stale
    return station;
  },

  async createTrain(data: CreateTrainInput) {
    const existing = await adminRepository.findTrainByNumber(data.trainNumber);
    if (existing) throw new ConflictError('TRAIN_EXISTS', `Train ${data.trainNumber} already exists`);

    // Resolve every station code → id, failing loudly if any is unknown.
    const codes  = data.stops.map((s) => s.stationCode);
    const idByCode = await adminRepository.stationIdsByCode(codes);
    const missing  = codes.filter((c) => !idByCode.has(c));
    if (missing.length > 0) {
      throw new BadRequestError('UNKNOWN_STATION', `Unknown station code(s): ${[...new Set(missing)].join(', ')}`);
    }

    // Reject duplicate stop orders within the request.
    const orders = data.stops.map((s) => s.stopOrder);
    if (new Set(orders).size !== orders.length) {
      throw new BadRequestError('DUPLICATE_STOP_ORDER', 'stopOrder values must be unique');
    }

    return adminRepository.createTrainWithStops({
      trainNumber: data.trainNumber,
      name:        data.name,
      runDays:     data.runDays,
      stops: data.stops.map((s) => ({
        stationId:     idByCode.get(s.stationCode)!,
        stopOrder:     s.stopOrder,
        arrivalTime:   s.arrivalTime ?? null,
        departureTime: s.departureTime ?? null,
        dayOffset:     s.dayOffset,
        distanceKm:    s.distanceKm,
      })),
    });
  },

  async updateTrain(trainNumber: string, data: UpdateTrainInput) {
    const existing = await adminRepository.findTrainByNumber(trainNumber);
    if (!existing) throw new NotFoundError(`Train ${trainNumber}`);
    const train = await adminRepository.updateTrain(trainNumber, data);
    await cacheDel(`train:${trainNumber}`); // cached static detail is now stale
    return train;
  },

  async createCoach(data: CreateCoachInput) {
    const train = await adminRepository.findTrainByNumber(data.trainNumber);
    if (!train) throw new NotFoundError(`Train ${data.trainNumber}`);

    const existing = await adminRepository.findCoach(train.id, data.coachNumber);
    if (existing) {
      throw new ConflictError('COACH_EXISTS', `Coach ${data.coachNumber} already exists on train ${data.trainNumber}`);
    }

    const classType = API_CLASS_TO_PRISMA[data.classType];
    return adminRepository.createCoachWithSeats(train.id, data.coachNumber, classType);
  },
};
