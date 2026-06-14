import { BerthType } from '@prisma/client';

// Berth layout per class, repeated along the coach. Keyed by the Prisma enum
// name (THREE_A, not "3A"). Shared by the seed and the admin coach endpoint so
// seat generation has a single source of truth.
export const BERTH_PATTERN: Record<string, BerthType[]> = {
  SL: [
    BerthType.LOWER, BerthType.MIDDLE, BerthType.UPPER,
    BerthType.LOWER, BerthType.MIDDLE, BerthType.UPPER,
    BerthType.SIDE_LOWER, BerthType.SIDE_UPPER,
  ],
  THREE_A: [
    BerthType.LOWER, BerthType.MIDDLE, BerthType.UPPER,
    BerthType.LOWER, BerthType.MIDDLE, BerthType.UPPER,
    BerthType.SIDE_LOWER, BerthType.SIDE_UPPER,
  ],
  TWO_A:   [BerthType.LOWER, BerthType.UPPER, BerthType.SIDE_LOWER, BerthType.SIDE_UPPER],
  FIRST_A: [BerthType.LOWER, BerthType.UPPER],
};

export const SEAT_COUNT: Record<string, number> = {
  SL: 72, THREE_A: 64, TWO_A: 46, FIRST_A: 18,
};

// Builds the seat rows for one coach: seat_number 1..N with berth_type cycling
// through the class pattern.
export function seatRows(coachId: string, classType: string) {
  const count   = SEAT_COUNT[classType];
  const pattern = BERTH_PATTERN[classType];
  return Array.from({ length: count }, (_, i) => ({
    coachId,
    seatNumber: i + 1,
    berthType:  pattern[i % pattern.length],
    version:    0,
  }));
}
