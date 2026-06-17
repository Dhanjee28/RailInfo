import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import { registerSchema, loginSchema } from '../validators/auth.validators';
import { trainSearchSchema } from '../validators/train.validators';
import { createBookingSchema, bookingHistoryQuerySchema } from '../validators/booking.validators';
import {
  createStationSchema,
  createTrainSchema,
  updateTrainSchema,
  createCoachSchema,
} from '../validators/admin.validators';

// Teaches zod the .openapi() method. Must run before any .openapi() call below.
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// ── Reusable response envelopes ──────────────────────────────────────────────
const errorEnvelope = z
  .object({
    success: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  })
  .openapi('ErrorResponse');

function success(data: z.ZodTypeAny, description = 'Success') {
  return { description, content: { 'application/json': { schema: z.object({ success: z.literal(true), data }) } } };
}
const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorEnvelope } },
});
const jsonBody = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });

// registerPath enumerates .shape for query/params, so it needs a ZodObject —
// unwrap any .refine()-wrapped schema (ZodEffects) to its inner object.
const asObject = (schema: z.ZodTypeAny): z.AnyZodObject =>
  (schema instanceof z.ZodEffects ? schema._def.schema : schema) as z.AnyZodObject;

const secured = [{ [bearerAuth.name]: [] as string[] }];
const pnrParam   = z.object({ pnr: z.string() });
const trainParam = z.object({ trainNumber: z.string() });

// ── Auth ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/auth/register', tags: ['Auth'], summary: 'Register a new user',
  request: { body: jsonBody(registerSchema) },
  responses: { 201: success(z.object({ user: z.any() }), 'User created'), 400: error('Validation error'), 409: error('Email already registered') },
});
registry.registerPath({
  method: 'post', path: '/auth/login', tags: ['Auth'], summary: 'Log in; returns access token + sets refresh cookie',
  request: { body: jsonBody(loginSchema) },
  responses: { 200: success(z.object({ accessToken: z.string(), user: z.any() })), 401: error('Invalid credentials'), 429: error('Rate limited') },
});
registry.registerPath({
  method: 'post', path: '/auth/refresh', tags: ['Auth'], summary: 'Rotate refresh token (httpOnly cookie); returns new access token',
  responses: { 200: success(z.object({ accessToken: z.string(), user: z.any() })), 401: error('Missing/invalid/reused refresh token') },
});
registry.registerPath({
  method: 'post', path: '/auth/logout', tags: ['Auth'], summary: 'Revoke refresh token + clear cookie',
  responses: { 200: success(z.object({ loggedOut: z.boolean() })) },
});

// ── Trains ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/trains/search', tags: ['Trains'], summary: 'Search trains between two stations on a date',
  request: { query: asObject(trainSearchSchema) },
  responses: { 200: success(z.object({ trains: z.array(z.any()), journeyDate: z.string() })), 400: error('Validation error') },
});
registry.registerPath({
  method: 'get', path: '/trains/{trainNumber}', tags: ['Trains'], summary: 'Train route + (optional) per-class availability',
  request: { params: trainParam, query: z.object({ date: z.string().optional() }) },
  responses: { 200: success(z.object({ train: z.any() })), 404: error('Train not found') },
});

// ── Stations ─────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/stations', tags: ['Stations'], summary: 'List all stations (cached)',
  responses: { 200: success(z.object({ stations: z.array(z.any()) })) },
});

// ── PNR ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/pnr/{pnr}', tags: ['PNR'], summary: 'Public PNR status (per-passenger)',
  request: { params: pnrParam },
  responses: { 200: success(z.object({ pnr: z.string(), passengers: z.array(z.any()) })), 404: error('PNR not found') },
});

// ── Bookings (auth) ──────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/bookings', tags: ['Bookings'], summary: 'Create a booking (allocates CNF/RAC/WL)', security: secured,
  request: { body: jsonBody(createBookingSchema) },
  responses: { 201: success(z.object({ pnr: z.string(), status: z.string(), passengers: z.array(z.any()) })), 401: error('Unauthorized'), 409: error('Waitlist full'), 429: error('Rate limited') },
});
registry.registerPath({
  method: 'get', path: '/bookings', tags: ['Bookings'], summary: 'Authenticated user booking history (paginated)', security: secured,
  request: { query: bookingHistoryQuerySchema },
  responses: { 200: success(z.object({ bookings: z.array(z.any()), pagination: z.any() })), 401: error('Unauthorized') },
});
registry.registerPath({
  method: 'get', path: '/bookings/{pnr}', tags: ['Bookings'], summary: 'Booking detail (owner only)', security: secured,
  request: { params: pnrParam },
  responses: { 200: success(z.any()), 401: error('Unauthorized'), 403: error('Not owner'), 404: error('Not found') },
});
registry.registerPath({
  method: 'post', path: '/bookings/{pnr}/cancel', tags: ['Bookings'], summary: 'Cancel booking (triggers promotions)', security: secured,
  request: { params: pnrParam },
  responses: { 200: success(z.object({ pnr: z.string(), status: z.string() })), 401: error('Unauthorized'), 403: error('Not owner'), 409: error('Already cancelled') },
});

// ── Admin (ADMIN role) ───────────────────────────────────────────────────────
registry.registerPath({
  method: 'post', path: '/admin/stations', tags: ['Admin'], summary: 'Create a station', security: secured,
  request: { body: jsonBody(createStationSchema) },
  responses: { 201: success(z.object({ station: z.any() })), 403: error('Requires ADMIN'), 409: error('Station exists') },
});
registry.registerPath({
  method: 'post', path: '/admin/trains', tags: ['Admin'], summary: 'Create a train + stops', security: secured,
  request: { body: jsonBody(createTrainSchema) },
  responses: { 201: success(z.object({ train: z.any() })), 400: error('Unknown station / bad route'), 403: error('Requires ADMIN'), 409: error('Train exists') },
});
registry.registerPath({
  method: 'patch', path: '/admin/trains/{trainNumber}', tags: ['Admin'], summary: 'Update train name / runDays', security: secured,
  request: { params: trainParam, body: jsonBody(updateTrainSchema) },
  responses: { 200: success(z.object({ train: z.any() })), 403: error('Requires ADMIN'), 404: error('Not found') },
});
registry.registerPath({
  method: 'post', path: '/admin/coaches', tags: ['Admin'], summary: 'Create a coach + auto-generate seats', security: secured,
  request: { body: jsonBody(createCoachSchema) },
  responses: { 201: success(z.object({ coach: z.any() })), 403: error('Requires ADMIN'), 404: error('Train not found'), 409: error('Coach exists') },
});

// Builds the OpenAPI 3.0 document. Paths are relative to the /api/v1 server.
export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'IRCTC Clone API',
      version: '1.0.0',
      description: 'Train booking backend. Request schemas are generated from the same Zod validators the API enforces, so docs cannot drift from validation.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
