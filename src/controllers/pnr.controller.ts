import { Request, Response } from 'express';
import { PassengerStatus } from '@prisma/client';
import { asyncHandler } from '../utils/asyncHandler';
import { bookingRepository } from '../repositories/booking.repository';
import { NotFoundError } from '../errors/AppError';

export const pnrController = {
  getStatus: asyncHandler(async (req: Request, res: Response) => {
    const pnr = String(req.params.pnr).toUpperCase();
    const booking = await bookingRepository.findByPnrPublic(pnr);

    if (!booking) throw new NotFoundError(`PNR ${pnr}`);

    res.json({
      success: true,
      data: {
        pnr:           booking.pnr,
        train:         { number: booking.train.trainNumber, name: booking.train.name },
        journeyDate:   booking.journeyDate,
        from:          booking.fromStop.station.code,
        to:            booking.toStop.station.code,
        bookingStatus: booking.status,
        passengers:    booking.passengers.map((p) => ({
          name:   p.name,
          age:    p.age,
          gender: p.gender,
          status: p.status,
          berth:  formatBerth(p),
        })),
      },
    });
  }),
};

// Formats the berth/position string exactly as IRCTC displays it on the status page.
type PassengerRow = NonNullable<
  Awaited<ReturnType<typeof bookingRepository.findByPnrPublic>>
>['passengers'][number];

function formatBerth(p: PassengerRow): string {
  switch (p.status) {
    case PassengerStatus.CONFIRMED:
      if (!p.seat) return 'CNF';
      return `${p.seat.coach.coachNumber}/${p.seat.seatNumber} ${p.seat.berthType}`;
    case PassengerStatus.RAC:
      return `RAC ${p.racPosition}`;
    case PassengerStatus.WAITLISTED:
      return `WL ${p.waitlistPosition}`;
    case PassengerStatus.CANCELLED:
      return 'CANCELLED';
  }
}
