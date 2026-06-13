import { BookingStatus, ClassType, Gender, PassengerStatus, PaymentStatus } from '@prisma/client';
import { prisma } from '../config/prisma';

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

  // Atomically creates a booking + passengers (with assigned seats) + mock payment.
  // Returns the booking with passengers and seat info for the service to shape the response.
  async createBookingTx(data: {
    pnr:         string;
    userId:      string;
    trainId:     string;
    journeyDate: Date;
    fromStopId:  string;
    toStopId:    string;
    totalFare:   number;
    passengers:  Array<{ name: string; age: number; gender: Gender; seatId: string }>;
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
          status:      BookingStatus.CONFIRMED,
          totalFare:   data.totalFare,
          passengers: {
            create: data.passengers.map((p) => ({
              name:   p.name,
              age:    p.age,
              gender: p.gender,
              seatId: p.seatId,
              status: PassengerStatus.CONFIRMED,
            })),
          },
        },
        include: {
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

  // Atomically flips booking + all passengers → CANCELLED, payment → REFUNDED.
  async cancelBookingTx(bookingId: string, paymentId: string) {
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
    });
  },
};
