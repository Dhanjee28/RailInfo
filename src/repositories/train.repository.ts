import { BookingStatus, ClassType } from '@prisma/client';
import { prisma } from '../config/prisma';

export type AvailabilityMap = Partial<Record<ClassType, { total: number; available: number }>>;

export const trainRepository = {
  // Find all trains that have at least one stop at any of the given station codes.
  // We fetch more than needed and let the service filter source-before-dest.
  findTrainsStoppingAt(stationCodes: string[]) {
    return prisma.train.findMany({
      where: {
        stops: { some: { station: { code: { in: stationCodes } } } },
      },
      include: {
        stops: {
          include: { station: true },
          orderBy: { stopOrder: 'asc' },
        },
        coaches: {
          include: { _count: { select: { seats: true } } },
        },
      },
    });
  },

  findByTrainNumber(trainNumber: string) {
    return prisma.train.findUnique({
      where: { trainNumber },
      include: {
        stops: {
          include: { station: true },
          orderBy: { stopOrder: 'asc' },
        },
        coaches: {
          include: { _count: { select: { seats: true } } },
        },
      },
    });
  },

  // Returns total and available seats per class for a given train+date.
  // Two queries: one for totals (by coach), one for occupied (by active booking passengers).
  async getAvailability(trainId: string, journeyDate: Date): Promise<AvailabilityMap> {
    // ── Step 1: total seats per class ─────────────────────────────────────────
    const coaches = await prisma.coach.findMany({
      where: { trainId },
      include: { _count: { select: { seats: true } } },
    });

    const totals: Partial<Record<ClassType, number>> = {};
    for (const c of coaches) {
      totals[c.classType] = (totals[c.classType] ?? 0) + c._count.seats;
    }

    // ── Step 2: occupied seats per class (passengers with seats in active bookings) ──
    const passengers = await prisma.bookingPassenger.findMany({
      where: {
        seatId: { not: null },
        booking: {
          trainId,
          journeyDate,
          status: { not: BookingStatus.CANCELLED },
        },
      },
      select: {
        seat: { select: { coach: { select: { classType: true } } } },
      },
    });

    const occupied: Partial<Record<ClassType, number>> = {};
    for (const p of passengers) {
      const ct = p.seat!.coach.classType;
      occupied[ct] = (occupied[ct] ?? 0) + 1;
    }

    // ── Step 3: merge ─────────────────────────────────────────────────────────
    const result: AvailabilityMap = {};
    for (const [ct, total] of Object.entries(totals) as [ClassType, number][]) {
      result[ct] = { total, available: total - (occupied[ct] ?? 0) };
    }
    return result;
  },
};
