import { BerthType, BookingStatus, ClassType, Gender, PassengerStatus } from '@prisma/client';
import { allocationService, PassengerInput } from '../../src/services/allocation.service';
import { allocationRepository } from '../../src/repositories/allocation.repository';
import { ConflictError, NotFoundError } from '../../src/errors/AppError';

// allocationService is pure logic over four repository reads — mock the repo so
// these tests need no database.
jest.mock('../../src/repositories/allocation.repository', () => ({
  allocationRepository: {
    findClassConfig:        jest.fn(),
    findFreeSeats:          jest.fn(),
    findRacSeatOccupancy:   jest.fn(),
    findCurrentWlCount:     jest.fn(),
  },
}));

const repo = allocationRepository as jest.Mocked<typeof allocationRepository>;

const TRAIN = 'train-1';
const DATE  = new Date('2026-07-01');
const CLASS = ClassType.SL;

// ── Test data builders ───────────────────────────────────────────────────────
const seat = (id: string, berthType: BerthType) => ({ id, berthType }) as any;
const racBerth = (id: string, currentRacCount: number) => ({ id, currentRacCount }) as any;
const config = (racCapacity: number, maxWaitlist: number) =>
  ({ id: 'cfg', trainId: TRAIN, classType: CLASS, racCapacity, maxWaitlist }) as any;

const pax = (name: string, age: number): PassengerInput => ({ name, age, gender: Gender.M });

// Sets up the four repo reads for one allocation run.
function setup(opts: {
  config:   ReturnType<typeof config>;
  seats:    ReturnType<typeof seat>[];
  rac:      ReturnType<typeof racBerth>[];
  wlCount?: number;
}) {
  repo.findClassConfig.mockResolvedValue(opts.config);
  repo.findFreeSeats.mockResolvedValue(opts.seats);
  repo.findRacSeatOccupancy.mockResolvedValue(opts.rac);
  repo.findCurrentWlCount.mockResolvedValue(opts.wlCount ?? 0);
}

const allocate = (passengers: PassengerInput[]) =>
  allocationService.allocate(TRAIN, DATE, CLASS, passengers);

beforeEach(() => jest.clearAllMocks());

describe('allocationService.allocate', () => {

  it('throws NotFoundError when the class has no config', async () => {
    repo.findClassConfig.mockResolvedValue(null);
    await expect(allocate([pax('A', 30)])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('confirms everyone when there are enough seats', async () => {
    setup({
      config: config(4, 10),
      seats:  [seat('s1', BerthType.UPPER), seat('s2', BerthType.MIDDLE), seat('s3', BerthType.LOWER)],
      rac:    [],
    });

    const { bookingStatus, allocations } = await allocate([pax('A', 30), pax('B', 25)]);

    expect(bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(allocations.every((a) => a.status === PassengerStatus.CONFIRMED)).toBe(true);
    expect(allocations.every((a) => a.seatId !== null)).toBe(true);
  });

  it('gives a senior (age >= 60) a LOWER berth even when listed last', async () => {
    setup({
      config: config(4, 10),
      // No LOWER first in the pool — the senior must still be steered to it.
      seats:  [seat('upper', BerthType.UPPER), seat('lower', BerthType.LOWER)],
      rac:    [],
    });

    const { allocations } = await allocate([pax('Young', 30), pax('Senior', 67)]);

    const senior = allocations.find((a) => a.name === 'Senior')!;
    const young  = allocations.find((a) => a.name === 'Young')!;
    expect(senior.seatId).toBe('lower');
    expect(young.seatId).toBe('upper');
  });

  it('preserves original passenger order in the result', async () => {
    setup({
      config: config(4, 10),
      seats:  [seat('s1', BerthType.LOWER), seat('s2', BerthType.UPPER), seat('s3', BerthType.MIDDLE)],
      rac:    [],
    });

    const { allocations } = await allocate([pax('First', 70), pax('Second', 20), pax('Third', 65)]);
    expect(allocations.map((a) => a.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('fills RAC after seats run out, sharing exactly 2 passengers per side-lower berth', async () => {
    setup({
      config: config(4, 10),
      seats:  [],                                   // no confirmed seats
      rac:    [racBerth('b1', 0), racBerth('b2', 0)], // two empty RAC berths
    });

    const { bookingStatus, allocations } = await allocate([pax('A', 30), pax('B', 30), pax('C', 30)]);

    expect(bookingStatus).toBe(BookingStatus.RAC);
    expect(allocations.map((a) => a.seatId)).toEqual(['b1', 'b1', 'b2']); // 2 share b1, 3rd to b2
    expect(allocations.map((a) => a.racPosition)).toEqual([1, 2, 3]);
  });

  it('never puts a 3rd passenger on a side-lower berth — spills to waitlist instead', async () => {
    setup({
      config: config(4, 10),
      seats:  [],
      rac:    [racBerth('b1', 0)],   // only ONE berth → holds 2 max
    });

    const { allocations } = await allocate([pax('A', 30), pax('B', 30), pax('C', 30)]);

    expect(allocations[0].seatId).toBe('b1');
    expect(allocations[1].seatId).toBe('b1');
    expect(allocations[2].status).toBe(PassengerStatus.WAITLISTED); // 3rd cannot share b1
  });

  it('respects racCapacity even when berths still have physical room', async () => {
    setup({
      config: config(1, 10),          // only 1 RAC slot allowed
      seats:  [],
      rac:    [racBerth('b1', 0)],     // berth could hold 2, but capacity caps at 1
    });

    const { allocations } = await allocate([pax('A', 30), pax('B', 30)]);
    expect(allocations[0].status).toBe(PassengerStatus.RAC);
    expect(allocations[1].status).toBe(PassengerStatus.WAITLISTED);
  });

  it('produces a PARTIALLY_CONFIRMED booking on a CNF + RAC + WL split', async () => {
    setup({
      config: config(1, 5),
      seats:  [seat('s1', BerthType.MIDDLE)],   // 1 confirmed seat
      rac:    [racBerth('b1', 0)],               // 1 RAC slot (capped by racCapacity=1)
      wlCount: 0,
    });

    const { bookingStatus, allocations } = await allocate([pax('A', 30), pax('B', 30), pax('C', 30)]);

    expect(allocations.map((a) => a.status)).toEqual([
      PassengerStatus.CONFIRMED,
      PassengerStatus.RAC,
      PassengerStatus.WAITLISTED,
    ]);
    expect(bookingStatus).toBe(BookingStatus.PARTIALLY_CONFIRMED);
  });

  it('continues the waitlist count from existing WL passengers', async () => {
    setup({
      config: config(0, 10),
      seats:  [],
      rac:    [],
      wlCount: 4,        // 4 already waitlisted
    });

    const { allocations } = await allocate([pax('A', 30), pax('B', 30)]);
    expect(allocations.map((a) => a.waitlistPosition)).toEqual([5, 6]);
  });

  it('throws ConflictError(WAITLIST_FULL) when max_waitlist is exceeded', async () => {
    setup({
      config: config(0, 2),   // cap = 2
      seats:  [],
      rac:    [],
      wlCount: 2,             // already at the cap
    });

    await expect(allocate([pax('A', 30)])).rejects.toMatchObject({
      code:       'WAITLIST_FULL',
      statusCode: 409,
    });
    await expect(allocate([pax('A', 30)])).rejects.toBeInstanceOf(ConflictError);
  });
});
