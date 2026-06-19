import { BerthType, BookingStatus, ClassType, Gender, PassengerStatus } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { bookingRepository } from '../repositories/booking.repository';
import { trainRepository } from '../repositories/train.repository';
import { promotionService } from './promotion.service';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { withRedisLock } from '../utils/redisLock';
import { ForbiddenError, NotFoundError, ConflictError, BadRequestError } from '../errors/AppError';
import { createBookingSchema } from '../validators/booking.validators';

// Order cancelled passengers process in: confirmed seats free first (they trigger
// the longest promotion chain), then RAC slots, then plain waitlist gap-closing.
const CANCEL_ORDER: Record<PassengerStatus, number> = {
  [PassengerStatus.CONFIRMED]:  0,
  [PassengerStatus.RAC]:        1,
  [PassengerStatus.WAITLISTED]: 2,
  [PassengerStatus.CANCELLED]:  3,
};

// Fare in paise per km
const FARE_RATE: Record<ClassType, number> = {
  SL:      50,
  THREE_A: 150,
  TWO_A:   220,
  FIRST_A: 350,
};

// API classType strings → Prisma ClassType enum names
const API_CLASS_TO_PRISMA: Record<string, ClassType> = {
  'SL':  'SL',
  '3A':  'THREE_A',
  '2A':  'TWO_A',
  '1A':  'FIRST_A',
};

const BERTH_LABEL: Record<BerthType, string> = {
  LOWER:      'LOWER',
  MIDDLE:     'MIDDLE',
  UPPER:      'UPPER',
  SIDE_LOWER: 'SIDE LOWER',
  SIDE_UPPER: 'SIDE UPPER',
};

type SeatInfo = {
  seatNumber: number;
  berthType:  BerthType;
  coach:      { coachNumber: string };
} | null;

type CreateBookingInput = z.infer<typeof createBookingSchema>;

function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function generatePnr(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatSeat(seat: SeatInfo): string | null {
  if (!seat) return null;
  return `${seat.coach.coachNumber}/${seat.seatNumber} ${BERTH_LABEL[seat.berthType]}`;
}

export const bookingService = {
  async getHistory(userId: string, page: number, limit: number) {
    const { bookings, total } = await bookingRepository.findByUserId(userId, page, limit);

    return {
      bookings: bookings.map((b) => ({
        pnr:         b.pnr,
        trainNumber: b.train.trainNumber,
        trainName:   b.train.name,
        journeyDate: b.journeyDate.toISOString().split('T')[0],
        from:        b.fromStop.station.code,
        to:          b.toStop.station.code,
        status:      b.status,
        totalFare:   b.totalFare,
        passengers:  b._count.passengers,
        createdAt:   b.createdAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  },

  async create(userId: string, data: CreateBookingInput) {
    // 1. Resolve train
    const train = await trainRepository.findByTrainNumber(data.trainNumber);
    if (!train) throw new NotFoundError(`Train ${data.trainNumber}`);

    // 2. Resolve stops
    const fromStop = train.stops.find((s) => s.station.code === data.fromStation);
    const toStop   = train.stops.find((s) => s.station.code === data.toStation);
    if (!fromStop) throw new BadRequestError('STATION_NOT_ON_ROUTE', `${data.fromStation} is not a stop on train ${data.trainNumber}`);
    if (!toStop)   throw new BadRequestError('STATION_NOT_ON_ROUTE', `${data.toStation} is not a stop on train ${data.trainNumber}`);

    // 3. Direction check
    if (fromStop.stopOrder >= toStop.stopOrder) {
      throw new BadRequestError('BAD_ROUTE', `${data.fromStation} does not come before ${data.toStation} on this train`);
    }

    const journeyDate    = parseDate(data.journeyDate);
    const classType      = API_CLASS_TO_PRISMA[data.classType];
    const passengerCount = data.passengers.length;

    // 4. Fare calculation — every passenger pays; WL/RAC are refunded on cancel.
    const distanceKm = toStop.distanceKm - fromStop.distanceKm;
    const totalFare  = distanceKm * FARE_RATE[classType] * passengerCount;

    const passengers = data.passengers.map((p) => ({ name: p.name, age: p.age, gender: p.gender as Gender }));

    // 5–8. Allocate + write atomically using the configured concurrency strategy
    // (Phase 4). Allocation (CNF/RAC/WL fill, WL cap → WAITLIST_FULL 409) runs
    // inside the repo method's transaction so a concurrent booking can't interleave
    // the read and write. PNR retry handles the astronomically rare collision.
    const runCreate = (args: Parameters<typeof bookingRepository.createBookingWithLock>[0]) => {
      switch (env.LOCK_STRATEGY) {
        case 'optimistic':
          return bookingRepository.createBookingOptimistic(args);
        case 'redis': {
          // Coarse lock over the whole train+date+class; the write needs no DB lock.
          const date = args.journeyDate.toISOString().slice(0, 10);
          const key  = `lock:booking:${args.trainId}:${date}:${args.classType}`;
          return withRedisLock(key, 5000, () => bookingRepository.createBookingNoSeatLock(args));
        }
        default:
          return bookingRepository.createBookingWithLock(args);
      }
    };

    let booking;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        booking = await runCreate({
          pnr:         generatePnr(),
          userId,
          trainId:     train.id,
          journeyDate,
          fromStopId:  fromStop.id,
          toStopId:    toStop.id,
          totalFare,
          classType,
          passengers,
        });
        break;
      } catch (err) {
        // P2002 = unique constraint violation; only retry for PNR collisions
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }

    if (!booking) throw new ConflictError('PNR_GENERATION_FAILED', 'Could not generate a unique PNR — please retry');

    logger.info('booking created', {
      pnr:        booking.pnr,
      status:     booking.status,
      trainId:    train.id,
      passengers: booking.passengers.length,
    });

    return {
      pnr:        booking.pnr,
      status:     booking.status,
      totalFare:  booking.totalFare,
      passengers: booking.passengers.map((p) => ({
        name:             p.name,
        age:              p.age,
        gender:           p.gender,
        status:           p.status,
        seat:             formatSeat(p.seat),
        racPosition:      p.racPosition,
        waitlistPosition: p.waitlistPosition,
      })),
    };
  },

  async cancel(userId: string, pnr: string) {
    const booking = await bookingRepository.findByPnrForCancel(pnr);
    if (!booking) throw new NotFoundError('Booking');
    if (booking.userId !== userId) throw new ForbiddenError('You do not own this booking');
    if (booking.status === BookingStatus.CANCELLED) {
      throw new ConflictError('ALREADY_CANCELLED', 'This booking has already been cancelled');
    }

    const payment = booking.payments[0];

    // Capture each passenger's PRE-cancel state, ordered so confirmed seats free
    // before RAC slots. The cancel tx flips these rows to CANCELLED, then we run
    // the promotion chain for each — all inside one transaction (see repository).
    const toPromote = booking.passengers
      .filter((p) => p.status !== PassengerStatus.CANCELLED)
      .sort((a, b) => CANCEL_ORDER[a.status] - CANCEL_ORDER[b.status]);

    await bookingRepository.cancelBookingTx(booking.id, payment.id, async (tx) => {
      for (const p of toPromote) {
        // classType is null only for pre-Phase-2 rows; promotion can't be scoped
        // without it, so skip (those bookings predate the waitlist mechanism).
        if (!p.classType) continue;
        await promotionService.runAfterCancellation(
          booking.trainId,
          booking.journeyDate,
          {
            id:               p.id,
            status:           p.status,
            seatId:           p.seatId,
            classType:        p.classType,
            racPosition:      p.racPosition,
            waitlistPosition: p.waitlistPosition,
          },
          tx,
        );
      }
    });

    logger.info('booking cancelled', {
      pnr:           booking.pnr,
      passengers:    toPromote.length,
      trainId:       booking.trainId,
    });

    return { pnr: booking.pnr, status: BookingStatus.CANCELLED };
  },

  async getDetail(userId: string, pnr: string) {
    const booking = await bookingRepository.findByPnr(pnr);
    if (!booking) throw new NotFoundError('Booking');
    // ADMIN bypass deferred to Phase 3 RBAC
    if (booking.userId !== userId) throw new ForbiddenError('You do not own this booking');

    const payment = booking.payments[0] ?? null;

    return {
      pnr:         booking.pnr,
      trainNumber: booking.train.trainNumber,
      trainName:   booking.train.name,
      journeyDate: booking.journeyDate.toISOString().split('T')[0],
      from:        { code: booking.fromStop.station.code, name: booking.fromStop.station.name },
      to:          { code: booking.toStop.station.code,   name: booking.toStop.station.name },
      status:      booking.status,
      totalFare:   booking.totalFare,
      passengers:  booking.passengers.map((p) => ({
        name:   p.name,
        age:    p.age,
        gender: p.gender,
        status: p.status,
        seat:   formatSeat(p.seat),
      })),
      payment: payment ? { status: payment.status, amount: payment.amount } : null,
    };
  },
};
