import { BookingStatus, ClassType, Gender, PassengerStatus, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { allocationRepository } from './allocation.repository';
import { allocatePassengers, PassengerInput } from '../domain/allocation';
import { ConflictError, NotFoundError } from '../errors/AppError';

// Internal sentinel for an optimistic-lock version mismatch — caught by the
// retry loop, never surfaced to the client.
class OptimisticConflict extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared passenger include shape for booking responses.
const BOOKING_RESPONSE_INCLUDE = {
  passengers: {
    select: {
      name: true, age: true, gender: true, status: true,
      racPosition: true, waitlistPosition: true,
      seat: { select: { seatNumber: true, berthType: true, coach: { select: { coachNumber: true } } } },
    },
  },
} satisfies Prisma.BookingInclude;

export const bookingRepository = {
  async findByUserId(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where: { userId },
        include: {
          train:    { select: { trainNumber: true, name: true } },
          fromStop: { include: { station: { select: { code: true, name: true } } } },
          toStop:   { include: { station: { select: { code: true, name: true } } } },
          _count:   { select: { passengers: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.booking.count({ where: { userId } }),
    ]);
    return { bookings, total };
  },

  findByPnr(pnr: string) {
    return prisma.booking.findUnique({
      where: { pnr },
      include: {
        train:    { select: { trainNumber: true, name: true } },
        fromStop: { include: { station: { select: { code: true, name: true } } } },
        toStop:   { include: { station: { select: { code: true, name: true } } } },
        passengers: {
          select: {
            name:   true,
            age:    true,
            gender: true,
            status: true,
            seat: {
              select: {
                seatNumber: true,
                berthType:  true,
                coach: { select: { coachNumber: true } },
              },
            },
          },
        },
        payments: {
          select:  { id: true, status: true, amount: true },
          orderBy: { createdAt: 'desc' },
          take:    1,
        },
      },
    });
  },

  // Cancellation lookup — needs each passenger's pre-cancel status + position fields
  // so the promotion engine knows what slots are being freed. Includes the latest
  // payment (to flip it REFUNDED).
  findByPnrForCancel(pnr: string) {
    return prisma.booking.findUnique({
      where: { pnr },
      include: {
        passengers: {
          select: {
            id:               true,
            status:           true,
            seatId:           true,
            classType:        true,
            racPosition:      true,
            waitlistPosition: true,
          },
        },
        payments: {
          select:  { id: true },
          orderBy: { createdAt: 'desc' },
          take:    1,
        },
      },
    });
  },

  // Public PNR lookup — includes Phase 2 queue positions.
  // Omits payment details (not shown on public status page).
  findByPnrPublic(pnr: string) {
    return prisma.booking.findUnique({
      where: { pnr },
      include: {
        train:    { select: { trainNumber: true, name: true } },
        fromStop: { include: { station: { select: { code: true, name: true } } } },
        toStop:   { include: { station: { select: { code: true, name: true } } } },
        passengers: {
          select: {
            name:             true,
            age:              true,
            gender:           true,
            status:           true,
            waitlistPosition: true,
            racPosition:      true,
            seat: {
              select: {
                seatNumber: true,
                berthType:  true,
                coach: { select: { coachNumber: true } },
              },
            },
          },
        },
      },
    });
  },

  // Returns up to `count` seats of `classType` on `trainId` that have no active booking
  // on `journeyDate`. This is the Phase-1 check-then-act pattern — intentionally not
  // wrapped in a lock. Phase 4 fixes the race condition via SELECT FOR UPDATE.
  async findFreeSeats(trainId: string, journeyDate: Date, classType: ClassType, count: number) {
    const occupiedRows = await prisma.bookingPassenger.findMany({
      where: {
        seatId: { not: null },
        booking: {
          trainId,
          journeyDate,
          status: { not: BookingStatus.CANCELLED },
        },
      },
      select: { seatId: true },
    });

    const occupiedIds = occupiedRows.map((r) => r.seatId!);

    return prisma.seat.findMany({
      where: {
        coach: { trainId, classType },
        ...(occupiedIds.length > 0 && { id: { notIn: occupiedIds } }),
      },
      take: count,
    });
  },

  // Atomically creates a booking + passengers + mock payment.
  // Each passenger carries its own allocated status / seat / queue position
  // (produced by allocationService), so the booking can be a mix of CNF/RAC/WL.
  async createBookingTx(data: {
    pnr:           string;
    userId:        string;
    trainId:       string;
    journeyDate:   Date;
    fromStopId:    string;
    toStopId:      string;
    totalFare:     number;
    bookingStatus: BookingStatus;
    classType:     ClassType;
    passengers:    Array<{
      name:             string;
      age:              number;
      gender:           Gender;
      status:           PassengerStatus;
      seatId:           string | null;
      racPosition:      number | null;
      waitlistPosition: number | null;
    }>;
  }) {
    return prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          pnr:         data.pnr,
          userId:      data.userId,
          trainId:     data.trainId,
          journeyDate: data.journeyDate,
          fromStopId:  data.fromStopId,
          toStopId:    data.toStopId,
          status:      data.bookingStatus,
          totalFare:   data.totalFare,
          passengers: {
            create: data.passengers.map((p) => ({
              name:             p.name,
              age:              p.age,
              gender:           p.gender,
              seatId:           p.seatId,
              status:           p.status,
              classType:        data.classType,
              journeyDate:      data.journeyDate,
              racPosition:      p.racPosition,
              waitlistPosition: p.waitlistPosition,
            })),
          },
        },
        include: {
          passengers: {
            select: {
              name:             true,
              age:              true,
              gender:           true,
              status:           true,
              racPosition:      true,
              waitlistPosition: true,
              seat: {
                select: {
                  seatNumber: true,
                  berthType:  true,
                  coach: { select: { coachNumber: true } },
                },
              },
            },
          },
        },
      });

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amount:    data.totalFare,
          status:    PaymentStatus.SUCCESS,
        },
      });

      return booking;
    });
  },

  // TODO(DJ): rewrite this yourself before interviews.
  // Phase 4 — PESSIMISTIC LOCKING. Fixes the check-then-act race by doing the
  // seat read AND the booking write in ONE transaction, with the class's seat
  // rows locked FOR UPDATE first. A concurrent booking for the same class blocks
  // on the lock until this transaction commits, then re-reads occupancy and sees
  // the seats already taken — so the same seat can never be sold twice.
  async createBookingWithLock(data: {
    pnr:         string;
    userId:      string;
    trainId:     string;
    journeyDate: Date;
    fromStopId:  string;
    toStopId:    string;
    totalFare:   number;
    classType:   ClassType;
    passengers:  PassengerInput[];
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Lock every seat of this train+class, in ascending id order. Consistent
      //    lock ordering across all bookers prevents deadlocks; locking the whole
      //    class also covers the shared SIDE_LOWER RAC berths. Prisma's query API
      //    can't express FOR UPDATE, so this is raw SQL.
      const seatRows = await tx.seat.findMany({
        where:   { coach: { trainId: data.trainId, classType: data.classType } },
        select:  { id: true },
        orderBy: { id: 'asc' },
      });
      const seatIds = seatRows.map((s) => s.id);
      if (seatIds.length > 0) {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM seats WHERE id IN (${Prisma.join(seatIds)}) ORDER BY id FOR UPDATE`,
        );
      }

      // 2. Re-read config + occupancy INSIDE the lock — this is the post-lock
      //    re-check: whatever a competing booking committed before releasing is
      //    now visible. Sequential awaits (one tx connection, not Promise.all).
      const config = await allocationRepository.findClassConfig(data.trainId, data.classType, tx);
      if (!config) throw new NotFoundError(`${data.classType} class config for this train`);

      const freeSeats      = await allocationRepository.findFreeSeats(data.trainId, data.journeyDate, data.classType, tx);
      const racOccupancy   = await allocationRepository.findRacSeatOccupancy(data.trainId, data.journeyDate, data.classType, tx);
      const currentWlCount = await allocationRepository.findCurrentWlCount(data.trainId, data.journeyDate, data.classType, tx);

      // 3. Allocate (pure). Throws WAITLIST_FULL → rolls the transaction back.
      const { bookingStatus, allocations } = allocatePassengers(
        data.classType, config, freeSeats, racOccupancy, currentWlCount, data.passengers,
      );

      // 4. Write booking + passengers + payment, all still inside the lock.
      const booking = await tx.booking.create({
        data: {
          pnr:         data.pnr,
          userId:      data.userId,
          trainId:     data.trainId,
          journeyDate: data.journeyDate,
          fromStopId:  data.fromStopId,
          toStopId:    data.toStopId,
          status:      bookingStatus,
          totalFare:   data.totalFare,
          passengers: {
            create: allocations.map((p) => ({
              name:             p.name,
              age:              p.age,
              gender:           p.gender,
              seatId:           p.seatId,
              status:           p.status,
              classType:        data.classType,
              journeyDate:      data.journeyDate,
              racPosition:      p.racPosition,
              waitlistPosition: p.waitlistPosition,
            })),
          },
        },
        include: {
          passengers: {
            select: {
              name: true, age: true, gender: true, status: true,
              racPosition: true, waitlistPosition: true,
              seat: { select: { seatNumber: true, berthType: true, coach: { select: { coachNumber: true } } } },
            },
          },
        },
      });

      await tx.payment.create({
        data: { bookingId: booking.id, amount: data.totalFare, status: PaymentStatus.SUCCESS },
      });

      return booking;
    });
  },

  // TODO(DJ): rewrite this yourself before interviews.
  // Phase 4 — OPTIMISTIC LOCKING. No upfront lock: read seats + their `version`,
  // allocate, then in a transaction conditionally bump `version` on each assigned
  // seat (UPDATE ... WHERE id=? AND version=?). If any guarded update touches 0
  // rows, another booking claimed that seat first → retry the whole attempt with
  // jittered backoff (re-reading fresh state), then give up with 409. Cheaper
  // than pessimistic locking when conflicts are rare; wasteful under heavy
  // contention (lots of retries) — the opposite tradeoff to step (b).
  async createBookingOptimistic(data: {
    pnr:         string;
    userId:      string;
    trainId:     string;
    journeyDate: Date;
    fromStopId:  string;
    toStopId:    string;
    totalFare:   number;
    classType:   ClassType;
    passengers:  PassengerInput[];
  }) {
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 1. Read config + occupancy WITHOUT locking, capturing each seat's version.
      //    All reads share ONE snapshot (RepeatableRead) so a seat reported free
      //    carries the version that matches that free state — otherwise findFreeSeats'
      //    two internal queries could straddle a competitor's commit, reporting a
      //    seat "free" with an already-incremented version and defeating the guard.
      const { config, freeSeats, racOccupancy, currentWlCount } = await prisma.$transaction(
        async (rtx) => ({
          config:         await allocationRepository.findClassConfig(data.trainId, data.classType, rtx),
          freeSeats:      await allocationRepository.findFreeSeats(data.trainId, data.journeyDate, data.classType, rtx),
          racOccupancy:   await allocationRepository.findRacSeatOccupancy(data.trainId, data.journeyDate, data.classType, rtx),
          currentWlCount: await allocationRepository.findCurrentWlCount(data.trainId, data.journeyDate, data.classType, rtx),
        }),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      if (!config) throw new NotFoundError(`${data.classType} class config for this train`);

      const versionBySeat = new Map<string, number>();
      for (const s of freeSeats)    versionBySeat.set(s.id, s.version);
      for (const r of racOccupancy) versionBySeat.set(r.id, r.version);

      // 2. Allocate (pure).
      const { bookingStatus, allocations } = allocatePassengers(
        data.classType, config, freeSeats, racOccupancy, currentWlCount, data.passengers,
      );

      try {
        const booking = await prisma.$transaction(async (tx) => {
          // 3. Version-guard every seat/berth we're about to claim. A 0-row
          //    update means someone bumped the version since our read → conflict.
          //    Dedupe: an RAC berth shared by 2 passengers in this booking appears
          //    twice but is one mutation.
          const claimedSeatIds = [...new Set(allocations.map((a) => a.seatId).filter((id): id is string => id !== null))];
          for (const seatId of claimedSeatIds) {
            const expected = versionBySeat.get(seatId) ?? 0;
            // Raw conditional UPDATE: the version predicate lives in the UPDATE's
            // WHERE, so Postgres re-evaluates it against the freshly-committed row
            // after the row lock (EvalPlanQual). A 0-row result = lost the race.
            const affected = await tx.$executeRaw(
              Prisma.sql`UPDATE seats SET version = version + 1 WHERE id = ${seatId} AND version = ${expected}`,
            );
            if (affected === 0) throw new OptimisticConflict();
          }

          // 4. All guards passed — write the booking + passengers + payment.
          const created = await tx.booking.create({
            data: {
              pnr:         data.pnr,
              userId:      data.userId,
              trainId:     data.trainId,
              journeyDate: data.journeyDate,
              fromStopId:  data.fromStopId,
              toStopId:    data.toStopId,
              status:      bookingStatus,
              totalFare:   data.totalFare,
              passengers: {
                create: allocations.map((p) => ({
                  name:             p.name,
                  age:              p.age,
                  gender:           p.gender,
                  seatId:           p.seatId,
                  status:           p.status,
                  classType:        data.classType,
                  journeyDate:      data.journeyDate,
                  racPosition:      p.racPosition,
                  waitlistPosition: p.waitlistPosition,
                })),
              },
            },
            include: BOOKING_RESPONSE_INCLUDE,
          });

          await tx.payment.create({
            data: { bookingId: created.id, amount: data.totalFare, status: PaymentStatus.SUCCESS },
          });

          return created;
        });

        return booking; // committed cleanly
      } catch (err) {
        if (err instanceof OptimisticConflict) {
          await sleep(Math.random() * 50 + attempt * 25); // jittered backoff, then retry
          continue;
        }
        throw err;
      }
    }

    // Exhausted retries — the class is under heavy contention right now.
    throw new ConflictError('SEAT_CONTENTION', 'Could not secure seats after several attempts — please retry');
  },

  // Phase 4 — booking write with NO DB-level seat lock. Correct ONLY when the
  // caller already holds mutual exclusion for this train+date+class (the Redis
  // distributed lock — see withRedisLock + the 'redis' LOCK_STRATEGY). Allocation
  // read + write still share one transaction for atomicity.
  async createBookingNoSeatLock(data: {
    pnr:         string;
    userId:      string;
    trainId:     string;
    journeyDate: Date;
    fromStopId:  string;
    toStopId:    string;
    totalFare:   number;
    classType:   ClassType;
    passengers:  PassengerInput[];
  }) {
    return prisma.$transaction(async (tx) => {
      const config = await allocationRepository.findClassConfig(data.trainId, data.classType, tx);
      if (!config) throw new NotFoundError(`${data.classType} class config for this train`);

      const freeSeats      = await allocationRepository.findFreeSeats(data.trainId, data.journeyDate, data.classType, tx);
      const racOccupancy   = await allocationRepository.findRacSeatOccupancy(data.trainId, data.journeyDate, data.classType, tx);
      const currentWlCount = await allocationRepository.findCurrentWlCount(data.trainId, data.journeyDate, data.classType, tx);

      const { bookingStatus, allocations } = allocatePassengers(
        data.classType, config, freeSeats, racOccupancy, currentWlCount, data.passengers,
      );

      const booking = await tx.booking.create({
        data: {
          pnr:         data.pnr,
          userId:      data.userId,
          trainId:     data.trainId,
          journeyDate: data.journeyDate,
          fromStopId:  data.fromStopId,
          toStopId:    data.toStopId,
          status:      bookingStatus,
          totalFare:   data.totalFare,
          passengers: {
            create: allocations.map((p) => ({
              name:             p.name,
              age:              p.age,
              gender:           p.gender,
              seatId:           p.seatId,
              status:           p.status,
              classType:        data.classType,
              journeyDate:      data.journeyDate,
              racPosition:      p.racPosition,
              waitlistPosition: p.waitlistPosition,
            })),
          },
        },
        include: BOOKING_RESPONSE_INCLUDE,
      });

      await tx.payment.create({
        data: { bookingId: booking.id, amount: data.totalFare, status: PaymentStatus.SUCCESS },
      });

      return booking;
    });
  },

  // Atomically flips booking + all passengers → CANCELLED, payment → REFUNDED,
  // then runs `onCancelled` inside the SAME transaction so the promotion chain
  // (RAC→CNF, WL→RAC) is atomic with the cancellation. A half-applied promotion
  // would be corruption — hence one transaction boundary for the whole operation.
  async cancelBookingTx(
    bookingId:   string,
    paymentId:   string,
    onCancelled: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.bookingPassenger.updateMany({
        where: { bookingId },
        data:  { status: PassengerStatus.CANCELLED },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data:  { status: BookingStatus.CANCELLED },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data:  { status: PaymentStatus.REFUNDED },
      });
      await onCancelled(tx);
    });
  },
};
