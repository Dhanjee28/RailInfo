import { BerthType, ClassType, PassengerStatus, Prisma } from '@prisma/client';
import { PassengerStateMachine } from './passengerStateMachine';
import { logger } from '../utils/logger';

// The transaction client type Prisma passes into $transaction callbacks.
type Tx = Omit<Prisma.TransactionClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// Shape of a cancelled passenger as the booking service sees it after cancel.
export type CancelledPassenger = {
  id:        string;
  status:    PassengerStatus;   // status BEFORE cancellation
  seatId:    string | null;
  classType: ClassType;
  waitlistPosition: number | null;
  racPosition:      number | null;
};

export const promotionService = {
  // Called inside the cancel transaction, once per cancelled passenger.
  // Cascades: CONFIRMED seat freed → RAC promoted → WL promoted → positions renumbered.
  async runAfterCancellation(
    trainId:     string,
    journeyDate: Date,
    passenger:   CancelledPassenger,
    tx:          Tx,
  ): Promise<void> {
    const { status, seatId, classType } = passenger;

    if (status === PassengerStatus.CONFIRMED) {
      // ── A confirmed seat opened up ──────────────────────────────────────────
      // 1. Promote the top RAC passenger into the freed confirmed seat.
      const topRac = await tx.bookingPassenger.findFirst({
        where: {
          status:    PassengerStatus.RAC,
          classType,
          booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
        },
        orderBy: { racPosition: 'asc' },
      });

      if (topRac) {
        PassengerStateMachine.transition(PassengerStatus.RAC, PassengerStatus.CONFIRMED);
        const freedSeatId = seatId!;
        await tx.bookingPassenger.update({
          where: { id: topRac.id },
          data:  { status: PassengerStatus.CONFIRMED, seatId: freedSeatId, racPosition: null },
        });
        logger.info('passenger promoted', { passengerId: topRac.id, from: 'RAC', to: 'CONFIRMED', classType });

        // Renumber remaining RAC positions (fill the gap left by topRac).
        await tx.bookingPassenger.updateMany({
          where: {
            status:      PassengerStatus.RAC,
            classType,
            racPosition: { gt: topRac.racPosition! },
            booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
          },
          data: { racPosition: { decrement: 1 } },
        });

        // 2. The RAC berth topRac vacated now has a free slot — promote top WL into it.
        await promoteTopWlToRac(trainId, journeyDate, classType, topRac.seatId!, tx);
      }

    } else if (status === PassengerStatus.RAC) {
      // ── A RAC berth slot opened up ──────────────────────────────────────────
      // Renumber the RAC positions above this one first.
      await tx.bookingPassenger.updateMany({
        where: {
          status:      PassengerStatus.RAC,
          classType,
          racPosition: { gt: passenger.racPosition! },
          booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
        },
        data: { racPosition: { decrement: 1 } },
      });

      // Now promote the top WL passenger into the freed berth slot.
      await promoteTopWlToRac(trainId, journeyDate, classType, seatId!, tx);

    } else if (status === PassengerStatus.WAITLISTED) {
      // ── A waitlist slot freed up — just close the gap ──────────────────────
      await tx.bookingPassenger.updateMany({
        where: {
          status:          PassengerStatus.WAITLISTED,
          classType,
          waitlistPosition: { gt: passenger.waitlistPosition! },
          booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
        },
        data: { waitlistPosition: { decrement: 1 } },
      });
    }
  },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

// Promotes the lowest-positioned WAITLISTED passenger to RAC on the given berth.
// Finds the current highest RAC position (to compute the new one), then updates
// the WL passenger and closes the gap in waitlist positions.
async function promoteTopWlToRac(
  trainId:     string,
  journeyDate: Date,
  classType:   ClassType,
  racSeatId:   string,
  tx:          Tx,
): Promise<void> {
  const topWl = await tx.bookingPassenger.findFirst({
    where: {
      status:    PassengerStatus.WAITLISTED,
      classType,
      booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
    },
    orderBy: { waitlistPosition: 'asc' },
  });

  if (!topWl) return; // waitlist is empty — nothing to promote

  // Verify the berth is actually SIDE_LOWER before assigning (guard against bad data).
  const berth = await tx.seat.findUnique({
    where:  { id: racSeatId },
    select: { berthType: true },
  });
  if (!berth || berth.berthType !== BerthType.SIDE_LOWER) return;

  // The new RAC position = current max + 1 (fills the end of the queue).
  const maxRacRow = await tx.bookingPassenger.aggregate({
    where: {
      status:    PassengerStatus.RAC,
      classType,
      booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
    },
    _max: { racPosition: true },
  });
  const newRacPosition = (maxRacRow._max.racPosition ?? 0) + 1;

  PassengerStateMachine.transition(PassengerStatus.WAITLISTED, PassengerStatus.RAC);
  await tx.bookingPassenger.update({
    where: { id: topWl.id },
    data: {
      status:           PassengerStatus.RAC,
      seatId:           racSeatId,
      racPosition:      newRacPosition,
      waitlistPosition: null,
    },
  });
  logger.info('passenger promoted', { passengerId: topWl.id, from: 'WAITLISTED', to: 'RAC', classType });

  // Close the gap in waitlist positions left by topWl.
  await tx.bookingPassenger.updateMany({
    where: {
      status:           PassengerStatus.WAITLISTED,
      classType,
      waitlistPosition: { gt: topWl.waitlistPosition! },
      booking: { trainId, journeyDate, status: { not: 'CANCELLED' } },
    },
    data: { waitlistPosition: { decrement: 1 } },
  });
}
