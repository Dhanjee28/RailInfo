import { PassengerStatus } from '@prisma/client';
import { BadRequestError } from '../errors/AppError';

// Legal transitions per the Phase 2 PNR state machine:
//
//   CONFIRMED  → CANCELLED
//   WAITLISTED → RAC       (promotion step 1 — never skip straight to CONFIRMED)
//   WAITLISTED → CANCELLED
//   RAC        → CONFIRMED (promotion step 2)
//   RAC        → CANCELLED
//
// CANCELLED is terminal. No backwards moves. No WL → CNF shortcut.
const ALLOWED: Readonly<Record<PassengerStatus, ReadonlySet<PassengerStatus>>> = {
  [PassengerStatus.CONFIRMED]:  new Set([PassengerStatus.CANCELLED]),
  [PassengerStatus.WAITLISTED]: new Set([PassengerStatus.RAC, PassengerStatus.CANCELLED]),
  [PassengerStatus.RAC]:        new Set([PassengerStatus.CONFIRMED, PassengerStatus.CANCELLED]),
  [PassengerStatus.CANCELLED]:  new Set(),
};

export class PassengerStateMachine {
  // Throws BadRequestError if the transition is illegal.
  // Call this before every status update — one enforcement point for the whole system.
  static transition(from: PassengerStatus, to: PassengerStatus): void {
    if (!ALLOWED[from].has(to)) {
      throw new BadRequestError(
        'INVALID_STATUS_TRANSITION',
        `Illegal passenger status transition: ${from} → ${to}`,
      );
    }
  }
}
