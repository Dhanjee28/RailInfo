import { ClassType } from '@prisma/client';
import { trainRepository, AvailabilityMap } from '../repositories/train.repository';
import { cacheAside } from '../utils/cache';
import { NotFoundError, BadRequestError } from '../errors/AppError';

// Cache TTLs (seconds). Search is short — availability changes constantly, so a
// 60s window is the honest staleness. Detail's STATIC part lives an hour.
const SEARCH_TTL = 60;
const DETAIL_TTL = 60 * 60;

type StaticTrainStop = {
  stopOrder:     number;
  station:       { code: string; name: string; city: string };
  arrivalTime:   string | null;
  departureTime: string | null;
  dayOffset:     number;
  distanceKm:    number;
};
type StaticTrain = {
  id:          string;
  trainNumber: string;
  name:        string;
  runDays:     number[];
  stops:       StaticTrainStop[];
};

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
  search(sourceCode: string, destCode: string, dateStr: string) {
    // Cache-aside: whole result for 60s. Availability is embedded but the short
    // TTL keeps it honest — search is a broad listing, not the booking path.
    return cacheAside(`search:${sourceCode}:${destCode}:${dateStr}`, SEARCH_TTL, () =>
      this.runSearch(sourceCode, destCode, dateStr),
    );
  },

  async runSearch(sourceCode: string, destCode: string, dateStr: string) {
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
    // Validate date BEFORE touching the cache — guard against e.g. 2026-02-30
    if (dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const parsed = new Date(Date.UTC(y, m - 1, d));
      if (parsed.getUTCMonth() !== m - 1) {
        throw new BadRequestError('INVALID_DATE', `${dateStr} is not a valid calendar date`);
      }
    }

    // Static route detail is cached (1h, invalidated on admin train edits).
    // Availability is NEVER cached — it's recomputed live below for the date.
    const cached = await cacheAside<StaticTrain | null>(`train:${trainNumber}`, DETAIL_TTL, async () => {
      const t = await trainRepository.findStaticByNumber(trainNumber);
      return t as StaticTrain | null;
    });
    if (!cached) throw new NotFoundError(`Train ${trainNumber}`);

    let availability: Record<string, { total: number; available: number }> | undefined;
    if (dateStr) {
      const raw = await trainRepository.getAvailability(cached.id, parseDate(dateStr));
      availability = labelledAvailability(raw);
    }

    const { id: _internalId, ...pub } = cached;
    return {
      train: {
        ...pub,
        ...(availability && { availability }),
      },
    };
  },
};
