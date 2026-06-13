import { BookingStatus, ClassType, Gender, PassengerStatus, PaymentStatus, Prisma } from '@prisma/client';
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
