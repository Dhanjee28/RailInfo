import { PassengerStatus } from '@prisma/client';
import { PassengerStateMachine } from '../../src/services/passengerStateMachine';
import { BadRequestError } from '../../src/errors/AppError';

const { CONFIRMED, WAITLISTED, RAC, CANCELLED } = PassengerStatus;

describe('PassengerStateMachine', () => {

  // ── Legal transitions ──────────────────────────────────────────────────────

  describe('legal transitions', () => {
    test.each([
      ['CONFIRMED  → CANCELLED',  CONFIRMED,  CANCELLED],
      ['WAITLISTED → RAC',        WAITLISTED, RAC      ],
      ['WAITLISTED → CANCELLED',  WAITLISTED, CANCELLED],
      ['RAC        → CONFIRMED',  RAC,        CONFIRMED],
      ['RAC        → CANCELLED',  RAC,        CANCELLED],
    ])('%s', (_label, from, to) => {
      expect(() => PassengerStateMachine.transition(from, to)).not.toThrow();
    });
  });

  // ── Illegal transitions ────────────────────────────────────────────────────

  describe('illegal transitions throw BadRequestError', () => {
    test.each([
      // No skipping RAC on the way up
      ['WAITLISTED → CONFIRMED (must step through RAC)', WAITLISTED, CONFIRMED],
      // No backwards moves
      ['CONFIRMED  → RAC',                               CONFIRMED,  RAC      ],
      ['CONFIRMED  → WAITLISTED',                        CONFIRMED,  WAITLISTED],
      ['RAC        → WAITLISTED',                        RAC,        WAITLISTED],
      // Terminal state — nothing leaves CANCELLED
      ['CANCELLED  → CONFIRMED',                         CANCELLED,  CONFIRMED],
      ['CANCELLED  → WAITLISTED',                        CANCELLED,  WAITLISTED],
      ['CANCELLED  → RAC',                               CANCELLED,  RAC      ],
    ])('%s', (_label, from, to) => {
      expect(() => PassengerStateMachine.transition(from, to)).toThrow(BadRequestError);
    });
  });

  // ── Error shape ────────────────────────────────────────────────────────────

  describe('error shape', () => {
    it('sets statusCode 400 and code INVALID_STATUS_TRANSITION', () => {
      let caught: unknown;
      try { PassengerStateMachine.transition(WAITLISTED, CONFIRMED); }
      catch (err) { caught = err; }

      expect(caught).toBeInstanceOf(BadRequestError);
      const err = caught as BadRequestError;
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('INVALID_STATUS_TRANSITION');
      expect(err.message).toContain('WAITLISTED');
      expect(err.message).toContain('CONFIRMED');
    });

    it('CANCELLED is truly terminal — all targets throw', () => {
      const allStatuses = [CONFIRMED, WAITLISTED, RAC, CANCELLED];
      for (const to of allStatuses) {
        expect(() => PassengerStateMachine.transition(CANCELLED, to)).toThrow(BadRequestError);
      }
    });
  });
});
