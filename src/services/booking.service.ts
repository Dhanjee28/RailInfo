// TODO(DJ): rewrite create() and cancel() yourself before interviews.
// These are the methods interviewers will ask you to walk through line by line.
import { BerthType, BookingStatus, ClassType } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { z } from 'zod';
import { bookingRepository } from '../repositories/booking.repository';
import { trainRepository } from '../repositories/train.repository';
import { ForbiddenError, NotFoundError, ConflictError, BadRequestError } from '../errors/AppError';
import { createBookingSchema } from '../validators/booking.validators';

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

    const journeyDate  = parseDate(data.journeyDate);
    const classType    = API_CLASS_TO_PRISMA[data.classType];
    const passengerCount = data.passengers.length;

    // 4–5. Availability check (check-then-act — intentional race condition, fixed in Phase 4)
    const freeSeats = await bookingRepository.findFreeSeats(train.id, journeyDate, classType, passengerCount);
    if (freeSeats.length < passengerCount) {
      throw new ConflictError('SEAT_UNAVAILABLE', `Not enough ${data.classType} seats available on ${data.journeyDate}`);
    }

    // 6. Fare calculation
    const distanceKm = toStop.distanceKm - fromStop.distanceKm;
    const totalFare  = distanceKm * FARE_RATE[classType] * passengerCount;

    // 7–8. Generate PNR, retry on the astronomically rare unique collision
    const passengersWithSeats = data.passengers.map((p, i) => ({
      name:   p.name,
      age:    p.age,
      gender: p.gender as 'M' | 'F' | 'O',
      seatId: freeSeats[i].id,
    }));

    let booking;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        booking = await bookingRepository.createBookingTx({
          pnr:         generatePnr(),
          userId,
          trainId:     train.id,
          journeyDate,
          fromStopId:  fromStop.id,
          toStopId:    toStop.id,
          totalFare,
          passengers:  passengersWithSeats,
        });
        break;
      } catch (err) {
        // P2002 = unique constraint violation; only retry for PNR collisions
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }

    if (!booking) throw new ConflictError('PNR_GENERATION_FAILED', 'Could not generate a unique PNR — please retry');

    return {
      pnr:        booking.pnr,
      status:     booking.status,
      totalFare:  booking.totalFare,
      passengers: booking.passengers.map((p) => ({
        name:   p.name,
        age:    p.age,
        gender: p.gender,
        status: p.status,
        seat:   formatSeat(p.seat),
      })),
    };
  },

  async cancel(userId: string, pnr: string) {
    const booking = await bookingRepository.findByPnr(pnr);
    if (!booking) throw new NotFoundError('Booking');
    if (booking.userId !== userId) throw new ForbiddenError('You do not own this booking');
    if (booking.status === BookingStatus.CANCELLED) {
      throw new ConflictError('ALREADY_CANCELLED', 'This booking has already been cancelled');
    }

    const payment = booking.payments[0];
    await bookingRepository.cancelBookingTx(booking.id, payment.id);

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
