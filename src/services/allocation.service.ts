// TODO(DJ): rewrite this yourself before interviews.
// This is the algorithmic heart of Phase 2 — interviewers will ask you to
// walk through the berth preference, RAC slot sharing, and WL cap logic.
import { BerthType, BookingStatus, ClassType, Gender, PassengerStatus } from '@prisma/client';
import { allocationRepository, FreeSeat, RacSeat } from '../repositories/allocation.repository';
import { ConflictError, NotFoundError } from '../errors/AppError';

// ─── Public types (used by booking service in step f) ─────────────────────────

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

// ─── Allocation service ────────────────────────────────────────────────────────

export const allocationService = {
  // Given a train, date, class, and list of passengers, returns each passenger's
  // assigned status + seat (CONFIRMED), RAC slot (RAC), or queue position (WL).
  // Throws WAITLIST_FULL if the last passenger would exceed max_waitlist.
  // Does NOT write to the DB — the booking service passes the result to
  // bookingRepository.createBookingTx in step (f).
  async allocate(
    trainId:     string,
    journeyDate: Date,
    classType:   ClassType,
    passengers:  PassengerInput[],
  ): Promise<AllocationResult> {

    // ── 1. Load config + current occupancy ──────────────────────────────────
    const config = await allocationRepository.findClassConfig(trainId, classType);
    if (!config) throw new NotFoundError(`${classType} class config for this train`);

    const [freeSeats, racOccupancy, currentWlCount] = await Promise.all([
      allocationRepository.findFreeSeats(trainId, journeyDate, classType),
      allocationRepository.findRacSeatOccupancy(trainId, journeyDate, classType),
      allocationRepository.findCurrentWlCount(trainId, journeyDate, classType),
    ]);

    // ── 2. Build mutable working state ──────────────────────────────────────
    const seatPool = [...freeSeats];

    // Per-berth RAC count — needed because each berth can hold at most 2 passengers
    const racCounts = new Map<string, number>(
      racOccupancy.map((s) => [s.id, s.currentRacCount]),
    );
    // Sorted list of berths that still have capacity (< 2 passengers)
    const racPool: RacSeat[] = racOccupancy.filter((s) => s.currentRacCount < 2);

    // Running total of RAC slots already sold across all bookings for this train+date+class
    const totalRacSold = racOccupancy.reduce((sum, s) => sum + s.currentRacCount, 0);

    // Counters for slots consumed within THIS booking (to detect mid-booking overflow)
    let racUsedThisBooking = 0;
    let nextWlPosition     = currentWlCount + 1;

    // ── 3. Sort passengers: seniors (≥60) first → they get LOWER berth priority ──
    const indexed = passengers.map((p, i) => ({ ...p, i }));
    indexed.sort((a, b) => (b.age >= 60 ? 1 : 0) - (a.age >= 60 ? 1 : 0));

    // ── 4. Allocate each passenger ───────────────────────────────────────────
    const results: (PassengerAllocation & { i: number })[] = [];

    for (const pax of indexed) {
      let alloc: PassengerAllocation;

      if (seatPool.length > 0) {
        // ── CONFIRMED ───────────────────────────────────────────────────────
        const seat = pickConfirmedSeat(seatPool, pax.age >= 60);
        seatPool.splice(seatPool.indexOf(seat), 1);
        alloc = {
          name: pax.name, age: pax.age, gender: pax.gender,
          status:           PassengerStatus.CONFIRMED,
          seatId:           seat.id,
          racPosition:      null,
          waitlistPosition: null,
        };

      } else if (
        totalRacSold + racUsedThisBooking < config.racCapacity &&
        racPool.length > 0
      ) {
        // ── RAC ─────────────────────────────────────────────────────────────
        // Pick the first berth that still has room; two passengers share each berth.
        const berth     = racPool[0];
        const newCount  = (racCounts.get(berth.id) ?? 0) + 1;
        racCounts.set(berth.id, newCount);
        if (newCount >= 2) racPool.shift(); // berth is now full

        alloc = {
          name: pax.name, age: pax.age, gender: pax.gender,
          status:           PassengerStatus.RAC,
          seatId:           berth.id,
          racPosition:      totalRacSold + racUsedThisBooking + 1,
          waitlistPosition: null,
        };
        racUsedThisBooking++;

      } else {
        // ── WAITLISTED ──────────────────────────────────────────────────────
        if (nextWlPosition > config.maxWaitlist) {
          throw new ConflictError(
            'WAITLIST_FULL',
            `No seats, RAC slots, or waitlist capacity for ${classType} on this date`,
          );
        }
        alloc = {
          name: pax.name, age: pax.age, gender: pax.gender,
          status:           PassengerStatus.WAITLISTED,
          seatId:           null,
          racPosition:      null,
          waitlistPosition: nextWlPosition++,
        };
      }

      results.push({ ...alloc, i: pax.i });
    }

    // ── 5. Restore original passenger order ──────────────────────────────────
    results.sort((a, b) => a.i - b.i);

    // ── 6. Derive booking-level status ───────────────────────────────────────
    const statuses = new Set(results.map((r) => r.status));
    let bookingStatus: BookingStatus;
    if (statuses.size === 1) {
      const only = [...statuses][0];
      bookingStatus =
        only === PassengerStatus.CONFIRMED  ? BookingStatus.CONFIRMED  :
        only === PassengerStatus.RAC        ? BookingStatus.RAC        :
                                              BookingStatus.WAITLISTED;
    } else {
      bookingStatus = BookingStatus.PARTIALLY_CONFIRMED;
    }

    return {
      bookingStatus,
      allocations: results.map(({ i: _i, ...a }) => a),
    };
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Picks the best available confirmed seat. Seniors get LOWER berth priority;
// all other passengers take the next seat in coach+number order.
function pickConfirmedSeat(pool: FreeSeat[], senior: boolean): FreeSeat {
  if (senior) {
    const lower = pool.find((s) => s.berthType === BerthType.LOWER);
    if (lower) return lower;
  }
  return pool[0];
}
