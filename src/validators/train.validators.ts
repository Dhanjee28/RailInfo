import { z } from 'zod';

export const trainSearchSchema = z
  .object({
    source:      z.string().trim().toUpperCase().min(2, 'source station code is required'),
    destination: z.string().trim().toUpperCase().min(2, 'destination station code is required'),
    date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  })
  .refine((d) => d.source !== d.destination, {
    message: 'source and destination must be different',
    path: ['destination'],
  });

export const trainDetailQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
});
