import { z } from 'zod';

const classTypeEnum = z.enum(['SL', '3A', '2A', '1A']);
const timeRegex     = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM 24h

export const createStationSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(10),
  name: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
});

const stopSchema = z.object({
  stationCode:   z.string().trim().toUpperCase().min(2).max(10),
  stopOrder:     z.coerce.number().int().positive(),
  arrivalTime:   z.string().regex(timeRegex, 'Must be HH:MM').nullable().optional(),
  departureTime: z.string().regex(timeRegex, 'Must be HH:MM').nullable().optional(),
  dayOffset:     z.coerce.number().int().min(0).default(0),
  distanceKm:    z.coerce.number().int().min(0),
});

export const createTrainSchema = z.object({
  trainNumber: z.string().trim().min(1).max(10),
  name:        z.string().trim().min(2).max(100),
  // Weekday bitmask as array of ints, 0=Sun … 6=Sat.
  runDays:     z.array(z.number().int().min(0).max(6)).min(1),
  stops:       z.array(stopSchema).min(2, 'A train needs at least 2 stops'),
})
  // stop_order must be strictly increasing and distance must grow with it.
  .refine((d) => {
    const sorted = [...d.stops].sort((a, b) => a.stopOrder - b.stopOrder);
    return sorted.every((s, i) => i === 0 || s.distanceKm > sorted[i - 1].distanceKm);
  }, { message: 'distanceKm must strictly increase with stopOrder', path: ['stops'] });

export const updateTrainSchema = z.object({
  name:    z.string().trim().min(2).max(100).optional(),
  runDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
})
  .refine((d) => d.name !== undefined || d.runDays !== undefined, {
    message: 'Provide at least one of name or runDays',
  });

export const createCoachSchema = z.object({
  trainNumber: z.string().trim().min(1).max(10),
  coachNumber: z.string().trim().min(1).max(10),
  classType:   classTypeEnum,
});
