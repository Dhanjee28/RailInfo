import { ClassType } from '@prisma/client';
import { trainRepository, AvailabilityMap } from '../repositories/train.repository';
import { NotFoundError, BadRequestError } from '../errors/AppError';

// Maps Prisma ClassType enum names to the human-readable labels clients expect.
const CLASS_LABEL: Record<ClassType, string> = {
  SL:      'SL',
  THREE_A: '3A',
  TWO_A:   '2A',
  FIRST_A: '1A',
};

// Parses "YYYY-MM-DD" to UTC midnight — avoids timezone-induced off-by-one day bugs.
function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function labelledAvailability(raw: AvailabilityMap) {
  const out: Record<string, { total: number; available: number }> = {};
  for (const [ct, counts] of Object.entries(raw) as [ClassType, { total: number; available: number }][]) {
    out[CLASS_LABEL[ct]] = counts;
  }
  return out;
}

export const trainService = {
  async search(sourceCode: string, destCode: string, dateStr: string) {
    const journeyDate = parseDate(dateStr);
    const weekday = journeyDate.getUTCDay(); // 0 = Sun … 6 = Sat

    const trains = await trainRepository.findTrainsStoppingAt([sourceCode, destCode]);

    const results = [];
    for (const train of trains) {
      const fromStop = train.stops.find((s) => s.station.code === sourceCode);
      const toStop   = train.stops.find((s) => s.station.code === destCode);

      // Both stations must be on this train's route, source must come before destination
      if (!fromStop || !toStop) continue;
      if (fromStop.stopOrder >= toStop.stopOrder) continue;

      // Train must run on the weekday of the journey date
      if (!train.runDays.includes(weekday)) continue;

      const availability = await trainRepository.getAvailability(train.id, journeyDate);

      results.push({
        trainNumber: train.trainNumber,
        name:        train.name,
        from: {
          stationCode:   fromStop.station.code,
          stationName:   fromStop.station.name,
          departureTime: fromStop.departureTime,
          dayOffset:     fromStop.dayOffset,
        },
        to: {
          stationCode:  toStop.station.code,
          stationName:  toStop.station.name,
          arrivalTime:  toStop.arrivalTime,
          dayOffset:    toStop.dayOffset,
        },
        distanceKm:   toStop.distanceKm - fromStop.distanceKm,
        availability:  labelledAvailability(availability),
      });
    }

    return { trains: results, journeyDate: dateStr };
  },

  async getDetails(trainNumber: string, dateStr?: string) {
    const train = await trainRepository.findByTrainNumber(trainNumber);
    if (!train) throw new NotFoundError(`Train ${trainNumber}`);

    // Validate date if provided — guard against a non-existent date like 2026-02-30
    if (dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const parsed = new Date(Date.UTC(y, m - 1, d));
      if (parsed.getUTCMonth() !== m - 1) {
        throw new BadRequestError('INVALID_DATE', `${dateStr} is not a valid calendar date`);
      }
    }

    const stops = train.stops.map((s) => ({
      stopOrder:     s.stopOrder,
      station:       { code: s.station.code, name: s.station.name, city: s.station.city },
      arrivalTime:   s.arrivalTime,
      departureTime: s.departureTime,
      dayOffset:     s.dayOffset,
      distanceKm:    s.distanceKm,
    }));

    let availability: Record<string, { total: number; available: number }> | undefined;
    if (dateStr) {
      const journeyDate = parseDate(dateStr);
      const raw = await trainRepository.getAvailability(train.id, journeyDate);
      availability = labelledAvailability(raw);
    }

    return {
      train: {
        trainNumber: train.trainNumber,
        name:        train.name,
        runDays:     train.runDays,
        stops,
        ...(availability && { availability }),
      },
    };
  },
};
