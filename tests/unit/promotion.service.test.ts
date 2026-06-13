import { BerthType, ClassType, PassengerStatus } from '@prisma/client';
import { promotionService, CancelledPassenger } from '../../src/services/promotion.service';

// promotionService.runAfterCancellation takes the transaction client as an
// argument, so we just hand it a fully-mocked tx — no jest.mock needed.
function makeTx() {
  return {
    bookingPassenger: {
      findFirst:  jest.fn(),
      update:     jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      aggregate:  jest.fn(),
    },
    seat: { findUnique: jest.fn() },
  };
}

const TRAIN = 'train-1';
const DATE  = new Date('2026-07-01');

const cancelled = (over: Partial<CancelledPassenger>): CancelledPassenger => ({
  id:               'p',
  status:           PassengerStatus.CONFIRMED,
  seatId:           null,
  classType:        ClassType.SL,
  racPosition:      null,
  waitlistPosition: null,
  ...over,
});

const run = (p: CancelledPassenger, tx: ReturnType<typeof makeTx>) =>
  promotionService.runAfterCancellation(TRAIN, DATE, p, tx as any);

describe('promotionService.runAfterCancellation', () => {

  // ── Waitlist cancellation: just close the gap ────────────────────────────────
  it('cancelling a WL passenger only shifts the positions behind it up', async () => {
    const tx = makeTx();

    await run(cancelled({ status: PassengerStatus.WAITLISTED, waitlistPosition: 3 }), tx);

    expect(tx.bookingPassenger.findFirst).not.toHaveBeenCalled();
    expect(tx.bookingPassenger.update).not.toHaveBeenCalled();
    expect(tx.bookingPassenger.updateMany).toHaveBeenCalledTimes(1);
    const arg = tx.bookingPassenger.updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe(PassengerStatus.WAITLISTED);
    expect(arg.where.waitlistPosition).toEqual({ gt: 3 });
    expect(arg.data).toEqual({ waitlistPosition: { decrement: 1 } });
  });

  // ── Confirmed cancellation: full RAC→CNF then WL→RAC cascade ──────────────────
  it('cancelling a CONFIRMED seat promotes top RAC to CNF, then top WL to RAC', async () => {
    const tx = makeTx();
    tx.bookingPassenger.findFirst
      .mockResolvedValueOnce({ id: 'rac1', racPosition: 1, seatId: 'berthX' }) // top RAC
      .mockResolvedValueOnce({ id: 'wl1', waitlistPosition: 1 });             // top WL
    tx.seat.findUnique.mockResolvedValue({ berthType: BerthType.SIDE_LOWER });
    tx.bookingPassenger.aggregate.mockResolvedValue({ _max: { racPosition: 3 } });

    await run(cancelled({ status: PassengerStatus.CONFIRMED, seatId: 'seatA' }), tx);

    // RAC #1 takes the freed confirmed seat
    expect(tx.bookingPassenger.update).toHaveBeenCalledWith({
      where: { id: 'rac1' },
      data:  { status: PassengerStatus.CONFIRMED, seatId: 'seatA', racPosition: null },
    });
    // WL #1 takes the vacated side-lower berth as the new last RAC (max 3 → 4)
    expect(tx.bookingPassenger.update).toHaveBeenCalledWith({
      where: { id: 'wl1' },
      data:  {
        status:           PassengerStatus.RAC,
        seatId:           'berthX',
        racPosition:      4,
        waitlistPosition: null,
      },
    });
    expect(tx.bookingPassenger.update).toHaveBeenCalledTimes(2);
  });

  it('cancelling a CONFIRMED seat with no one waiting promotes nobody', async () => {
    const tx = makeTx();
    tx.bookingPassenger.findFirst.mockResolvedValue(null); // no RAC waiting

    await run(cancelled({ status: PassengerStatus.CONFIRMED, seatId: 'seatA' }), tx);

    expect(tx.bookingPassenger.update).not.toHaveBeenCalled();
    expect(tx.bookingPassenger.findFirst).toHaveBeenCalledTimes(1);
  });

  // ── RAC cancellation: renumber RAC, promote top WL into the freed berth ───────
  it('cancelling an RAC slot promotes the top WL passenger into the freed berth', async () => {
    const tx = makeTx();
    tx.bookingPassenger.findFirst.mockResolvedValueOnce({ id: 'wl1', waitlistPosition: 1 });
    tx.seat.findUnique.mockResolvedValue({ berthType: BerthType.SIDE_LOWER });
    tx.bookingPassenger.aggregate.mockResolvedValue({ _max: { racPosition: 4 } });

    await run(cancelled({ status: PassengerStatus.RAC, seatId: 'berthA', racPosition: 2 }), tx);

    // First updateMany renumbers RAC positions above the cancelled one
    const racRenumber = tx.bookingPassenger.updateMany.mock.calls[0][0];
    expect(racRenumber.where.status).toBe(PassengerStatus.RAC);
    expect(racRenumber.where.racPosition).toEqual({ gt: 2 });

    // WL #1 promoted onto the freed berth
    expect(tx.bookingPassenger.update).toHaveBeenCalledWith({
      where: { id: 'wl1' },
      data:  {
        status:           PassengerStatus.RAC,
        seatId:           'berthA',
        racPosition:      5,
        waitlistPosition: null,
      },
    });
  });

  it('does not promote a WL passenger onto a non-side-lower seat (berth guard)', async () => {
    const tx = makeTx();
    tx.bookingPassenger.findFirst.mockResolvedValueOnce({ id: 'wl1', waitlistPosition: 1 });
    tx.seat.findUnique.mockResolvedValue({ berthType: BerthType.LOWER }); // not SIDE_LOWER

    await run(cancelled({ status: PassengerStatus.RAC, seatId: 'badSeat', racPosition: 1 }), tx);

    expect(tx.bookingPassenger.update).not.toHaveBeenCalled();
  });

  it('promotes nobody to RAC when the waitlist is empty', async () => {
    const tx = makeTx();
    tx.bookingPassenger.findFirst.mockResolvedValueOnce(null); // no WL

    await run(cancelled({ status: PassengerStatus.RAC, seatId: 'berthA', racPosition: 1 }), tx);

    expect(tx.seat.findUnique).not.toHaveBeenCalled();
    expect(tx.bookingPassenger.update).not.toHaveBeenCalled();
  });
});
