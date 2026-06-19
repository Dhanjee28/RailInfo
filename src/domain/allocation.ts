import { BerthType, BookingStatus, ClassType, Gender, PassengerStatus } from '@prisma/client';
import { ConflictError } from '../errors/AppError';

// Pure seat-allocation algorithm — no I/O. The caller fetches config + occupancy
// (optionally inside a locked transaction) and passes them in; this function
// just decides CONFIRMED / RAC / WAITLISTED per passenger. Keeping it pure makes
// it unit-testable and reusable by both the naive and the pessimistic-locked
// booking paths.

export type PassengerInput = {
  name:   string;
  age:    number;
  gender: Gender;
};

export type PassengerAllocation = {
  name:             string;
  age:              number;
  gender:           Gender;
  status:           PassengerStatus;
  seatId:           string | null;
  racPosition:      number | null;
  waitlistPosition: number | null;
};

export type AllocationResult = {
  bookingStatus: BookingStatus;
  allocations:   PassengerAllocation[];
};

type FreeSeatLike    = { id: string; berthType: BerthType };
type RacSeatLike     = { id: string; currentRacCount: number };
type ClassConfigLike = { racCapacity: number; maxWaitlist: number };

export function allocatePassengers(
  classType:      ClassType,
  config:         ClassConfigLike,
  freeSeats:      FreeSeatLike[],
  racOccupancy:   RacSeatLike[],
  currentWlCount: number,
  passengers:     PassengerInput[],
): AllocationResult {
  // ── Mutable working state ────────────────────────────────────────────────
  const seatPool = [...freeSeats];

  const racCounts = new Map<string, number>(racOccupancy.map((s) => [s.id, s.currentRacCount]));
  const racPool: RacSeatLike[] = racOccupancy.filter((s) => s.currentRacCount < 2);
  const totalRacSold = racOccupancy.reduce((sum, s) => sum + s.currentRacCount, 0);

  let racUsedThisBooking = 0;
  let nextWlPosition     = currentWlCount + 1;

  // Seniors (≥60) first → LOWER-berth priority. Original order restored at the end.
  const indexed = passengers.map((p, i) => ({ ...p, i }));
  indexed.sort((a, b) => (b.age >= 60 ? 1 : 0) - (a.age >= 60 ? 1 : 0));

  const results: (PassengerAllocation & { i: number })[] = [];

  for (const pax of indexed) {
    let alloc: PassengerAllocation;

    if (seatPool.length > 0) {
      // CONFIRMED
      const seat = pickConfirmedSeat(seatPool, pax.age >= 60);
      seatPool.splice(seatPool.indexOf(seat), 1);
      alloc = {
        name: pax.name, age: pax.age, gender: pax.gender,
        status: PassengerStatus.CONFIRMED, seatId: seat.id, racPosition: null, waitlistPosition: null,
      };
    } else if (totalRacSold + racUsedThisBooking < config.racCapacity && racPool.length > 0) {
      // RAC — two passengers share each side-lower berth
      const berth    = racPool[0];
      const newCount = (racCounts.get(berth.id) ?? 0) + 1;
      racCounts.set(berth.id, newCount);
      if (newCount >= 2) racPool.shift();
      alloc = {
        name: pax.name, age: pax.age, gender: pax.gender,
        status: PassengerStatus.RAC, seatId: berth.id,
        racPosition: totalRacSold + racUsedThisBooking + 1, waitlistPosition: null,
      };
      racUsedThisBooking++;
    } else {
      // WAITLISTED
      if (nextWlPosition > config.maxWaitlist) {
        throw new ConflictError('WAITLIST_FULL', `No seats, RAC slots, or waitlist capacity for ${classType} on this date`);
      }
      alloc = {
        name: pax.name, age: pax.age, gender: pax.gender,
        status: PassengerStatus.WAITLISTED, seatId: null, racPosition: null, waitlistPosition: nextWlPosition++,
      };
    }

    results.push({ ...alloc, i: pax.i });
  }

  results.sort((a, b) => a.i - b.i);

  const statuses = new Set(results.map((r) => r.status));
  let bookingStatus: BookingStatus;
  if (statuses.size === 1) {
    const only = [...statuses][0];
    bookingStatus =
      only === PassengerStatus.CONFIRMED ? BookingStatus.CONFIRMED :
      only === PassengerStatus.RAC       ? BookingStatus.RAC       :
                                           BookingStatus.WAITLISTED;
  } else {
    bookingStatus = BookingStatus.PARTIALLY_CONFIRMED;
  }

  return { bookingStatus, allocations: results.map(({ i: _i, ...a }) => a) };
}

// Seniors get LOWER-berth priority; everyone else takes the next seat in order.
function pickConfirmedSeat(pool: FreeSeatLike[], senior: boolean): FreeSeatLike {
  if (senior) {
    const lower = pool.find((s) => s.berthType === BerthType.LOWER);
    if (lower) return lower;
  }
  return pool[0];
}
