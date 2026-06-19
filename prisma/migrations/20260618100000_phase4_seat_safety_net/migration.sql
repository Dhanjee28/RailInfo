-- Denormalize journey_date onto booking_passengers (nullable first so existing
-- rows can be backfilled before the NOT NULL constraint).
ALTER TABLE "booking_passengers" ADD COLUMN "journey_date" DATE;

-- Backfill from the parent booking.
UPDATE "booking_passengers" bp
SET "journey_date" = b."journey_date"
FROM "bookings" b
WHERE bp."booking_id" = b."id";

ALTER TABLE "booking_passengers" ALTER COLUMN "journey_date" SET NOT NULL;

-- Safety net (defense in depth): a physical seat can hold at most ONE confirmed
-- passenger per journey date. Even if every application-level lock has a bug, the
-- DB turns a double-booking into a clean unique-violation (P2002 → 409) instead of
-- silent corruption. Partial:
--   * excludes RAC — a side-lower berth is shared by 2 RAC passengers (the 2-cap
--     is enforced in app logic, not here),
--   * excludes WAITLISTED (seat_id NULL) and CANCELLED (seat released).
CREATE UNIQUE INDEX "booking_passengers_seat_confirmed_unique"
  ON "booking_passengers" ("seat_id", "journey_date")
  WHERE "status" = 'CONFIRMED';
