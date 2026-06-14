import { ClassType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { seatRows } from '../domain/seatLayout';

export const adminRepository = {
  // ── Stations ────────────────────────────────────────────────────────────────
  findStationByCode(code: string) {
    return prisma.station.findUnique({ where: { code } });
  },

  createStation(data: { code: string; name: string; city: string }) {
    return prisma.station.create({ data });
  },

  // ── Trains ──────────────────────────────────────────────────────────────────
  findTrainByNumber(trainNumber: string) {
    return prisma.train.findUnique({ where: { trainNumber } });
  },

  // Maps the requested station codes to their ids in one query.
  async stationIdsByCode(codes: string[]) {
    const stations = await prisma.station.findMany({ where: { code: { in: codes } } });
    return new Map(stations.map((s) => [s.code, s.id]));
  },

  // Create the train and all its stops atomically.
  createTrainWithStops(data: {
    trainNumber: string;
    name:        string;
    runDays:     number[];
    stops:       Array<{
      stationId:     string;
      stopOrder:     number;
      arrivalTime:   string | null;
      departureTime: string | null;
      dayOffset:     number;
      distanceKm:    number;
    }>;
  }) {
    return prisma.train.create({
      data: {
        trainNumber: data.trainNumber,
        name:        data.name,
        runDays:     data.runDays,
        stops:       { create: data.stops },
      },
      include: { stops: { orderBy: { stopOrder: 'asc' } } },
    });
  },

  updateTrain(trainNumber: string, data: { name?: string; runDays?: number[] }) {
    return prisma.train.update({ where: { trainNumber }, data });
  },

  // ── Coaches ───────────────────────────────────────────────────────────────
  findCoach(trainId: string, coachNumber: string) {
    return prisma.coach.findUnique({
      where: { trainId_coachNumber: { trainId, coachNumber } },
    });
  },

  // Create the coach and its full set of seats atomically.
  createCoachWithSeats(trainId: string, coachNumber: string, classType: ClassType) {
    return prisma.$transaction(async (tx) => {
      const coach = await tx.coach.create({ data: { trainId, coachNumber, classType } });
      await tx.seat.createMany({ data: seatRows(coach.id, classType) });
      return tx.coach.findUniqueOrThrow({
        where:   { id: coach.id },
        include: { _count: { select: { seats: true } } },
      });
    });
  },
};

// Re-exported so the service can narrow on unique-constraint races if needed.
export const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
