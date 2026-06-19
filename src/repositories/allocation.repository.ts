import { BerthType, BookingStatus, ClassType, PassengerStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

// Accepts either the global client or a transaction client, so these reads can
// run inside a locked transaction (Phase 4 pessimistic locking) or standalone.
type Db = Prisma.TransactionClient | typeof prisma;

export const allocationRepository = {
  findClassConfig(trainId: string, classType: ClassType, db: Db = prisma) {
    return db.coachClassConfig.findUnique({
      where: { trainId_classType: { trainId, classType } },
    });
  },

  // Free non-SIDE_LOWER seats of the requested class.
  // SIDE_LOWER berths are reserved for RAC in Phase 2 — they never go into the
  // confirmed seat pool.
  async findFreeSeats(trainId: string, journeyDate: Date, classType: ClassType, db: Db = prisma) {
    const occupiedRows = await db.bookingPassenger.findMany({
      where: {
        seatId: { not: null },
        status: { not: PassengerStatus.CANCELLED },
        booking: { trainId, journeyDate, status: { not: BookingStatus.CANCELLED } },
      },
      select: { seatId: true },
    });

    const occupiedIds = occupiedRows.map((r) => r.seatId!);

    return db.seat.findMany({
      where: {
        berthType: { not: BerthType.SIDE_LOWER },
        coach:     { trainId, classType },
        ...(occupiedIds.length > 0 && { id: { notIn: occupiedIds } }),
      },
      include: { coach: { select: { coachNumber: true, classType: true } } },
      orderBy: [{ coach: { coachNumber: 'asc' } }, { seatNumber: 'asc' }],
    });
  },

  // Returns every SIDE_LOWER seat in the class alongside how many RAC passengers
  // are currently sharing it. Used by the allocation algorithm to find berths
  // with capacity left (< 2 RAC passengers per berth).
  async findRacSeatOccupancy(trainId: string, journeyDate: Date, classType: ClassType, db: Db = prisma) {
    const seats = await db.seat.findMany({
      where: {
        berthType: BerthType.SIDE_LOWER,
        coach:     { trainId, classType },
      },
      include: {
        coach: { select: { coachNumber: true, classType: true } },
        passengers: {
          where: {
            status: PassengerStatus.RAC,
            booking: { trainId, journeyDate, status: { not: BookingStatus.CANCELLED } },
          },
          select: { id: true },
        },
      },
      orderBy: [{ coach: { coachNumber: 'asc' } }, { seatNumber: 'asc' }],
    });

    return seats.map((s) => ({
      id:              s.id,
      seatNumber:      s.seatNumber,
      berthType:       s.berthType,
      coachId:         s.coachId,
      coach:           s.coach,
      version:         s.version,           // for optimistic locking (Phase 4 step c)
      currentRacCount: s.passengers.length,
    }));
  },

  // How many WAITLISTED passengers exist for this class on this train+date.
  // Uses the classType column added to booking_passengers in Phase 2.
  findCurrentWlCount(trainId: string, journeyDate: Date, classType: ClassType, db: Db = prisma): Promise<number> {
    return db.bookingPassenger.count({
      where: {
        status:    PassengerStatus.WAITLISTED,
        classType,
        booking: { trainId, journeyDate, status: { not: BookingStatus.CANCELLED } },
      },
    });
  },
};

// Infer the seat shape from Prisma's return type so the service doesn't need a
// separate type import.
export type FreeSeat = Awaited<ReturnType<typeof allocationRepository.findFreeSeats>>[number];
export type RacSeat  = Awaited<ReturnType<typeof allocationRepository.findRacSeatOccupancy>>[number];
