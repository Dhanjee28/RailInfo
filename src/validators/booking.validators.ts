import { z } from 'zod';

export const bookingHistoryQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const createBookingSchema = z.object({
  trainNumber:  z.string().min(1),
  journeyDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  fromStation:  z.string().min(1),
  toStation:    z.string().min(1),
  classType:    z.enum(['SL', '3A', '2A', '1A']),
  passengers:   z.array(z.object({
    name:   z.string().min(1),
    age:    z.coerce.number().int().min(1).max(120),
    gender: z.enum(['M', 'F', 'O']),
  })).min(1).max(6),
});
