# IRCTC Clone Backend

A production-minded booking system API built to learn and demonstrate backend engineering concepts for interviews.

**Stack:** Node.js · TypeScript · Express · PostgreSQL · Prisma · Redis (Phase 3) · Docker · JWT · Zod

## Running locally

```bash
# 1. Start Postgres
docker-compose up -d

# 2. Copy env
cp .env.example .env   # then edit JWT_SECRET

# 3. Install deps
npm install

# 4. Run migrations + seed (available after Phase 1 step b)
npm run db:migrate
npm run db:seed

# 5. Start dev server
npm run dev
```

## Project Structure

```
src/
├── config/       # env loading + zod validation
├── routes/       # URL → controller mapping only
├── controllers/  # HTTP concerns: parse, call service, shape response
├── services/     # all business logic (no HTTP, no SQL)
├── repositories/ # all DB access via Prisma
├── middlewares/  # auth, validate, errorHandler
├── validators/   # zod schemas per endpoint
├── errors/       # AppError + subclasses
└── utils/        # logger, response helpers
```

## Architecture Decisions — Phase 1

### Step (a) — Project Setup

**Layered architecture (routes → controllers → services → repositories)**
Controllers stay thin — they parse the HTTP request and delegate to a service. Services hold all business rules and never touch Prisma directly; that's the repository's job. This separation means you can unit-test a service by mocking its repository, swap Prisma for raw SQL without touching business logic, and immediately answer the interview question *"walk me through your structure and why."*

**Zod for env validation at startup**
`src/config/env.ts` parses `process.env` against a Zod schema and calls `process.exit(1)` if anything is missing or malformed. This turns a vague "DATABASE_URL is undefined" runtime crash — which can surface minutes into a request — into a loud, descriptive failure at process start. Zod also gives free TypeScript inference: `env.PORT` is typed `number`, not `string | undefined`.

**Custom `AppError` hierarchy + single global error handler**
Services throw typed errors (`ConflictError`, `NotFoundError`, etc.). The single `errorHandler` middleware in `app.ts` is the only place that shapes HTTP responses from errors. This means zero try/catch in controllers — they just call the service — and every error consistently produces the `{ success, error: { code, message } }` envelope.

**Structured JSON logging**
`src/utils/logger.ts` emits one JSON object per log line. In development this is verbose but machine-parseable; in production you pipe it to Datadog/CloudWatch. Debug lines are silenced in production automatically. A real logging library (Pino, Winston) enters in Phase 3 alongside full observability; the interface is identical, so swapping is a one-line change.

**Known race condition (intentional — see Phase 4)**
The Phase 1 booking flow uses a check-then-act pattern: read available seats, then create the booking. Two concurrent requests can read the same seat as free and both succeed, resulting in a double-booking. This is left in *on purpose*. Phase 4 fixes it via pessimistic locking (`SELECT … FOR UPDATE`), optimistic locking (the `seats.version` column), and Redis distributed locks — then benchmarks all three. The story "I shipped it, reproduced the race, then fixed it three ways" is the most defensible thing you can say in a senior backend interview.

### Step (b) — Prisma Schema, Migration, Seed

**`train_stops` is the schema's load-bearing table**
Every train's route is a sequence of rows in `train_stops`, each with `stop_order` and cumulative `distance_km` from the train's origin. Search works by finding trains where the source stop's `stop_order < destination stop_order`. Without this table you'd be hard-coding source/destination on the train — which breaks the moment a user wants an intermediate segment (Nagpur → Delhi on the Telangana Express, not just Secunderabad → Delhi). Interviewers call this "modeling the domain correctly."

**`ClassType` enum uses `@map` for digit-starting values**
PostgreSQL stores `'3A'`, `'2A'`, `'1A'` in the enum. TypeScript/Prisma uses `THREE_A`, `TWO_A`, `FIRST_A` internally. The `@map` annotation keeps the DB human-readable without violating TypeScript identifier rules. The service layer translates when building API responses.

**Availability is computed, not stored**
There is no `available_seats` counter on coaches or trains. Availability for a date = total seats of the requested class minus seats already assigned to active (non-CANCELLED) bookings for that train+date. This is what the composite index `(train_id, journey_date, status)` on bookings accelerates. Denormalized counters require careful increment/decrement logic and are exactly what creates lost-update bugs under concurrency — eliminating the counter also eliminates that whole failure mode.

**`seats.version` and `payments.idempotency_key` are planted early**
These columns are `DEFAULT 0` / nullable today and unused. They exist so Phases 4's optimistic lock (`WHERE version = $n`) and idempotent payment replay require zero schema migration. Reviewers always ask "how do you evolve the schema without downtime?" — this is the answer in practice: design the additive column in early and defer the logic.

**`booking_passengers.seat_id` is nullable by design**
`NULL` seat means "passenger has no assigned seat yet." In Phase 1 every confirmed passenger gets a seat; in Phase 2 a waitlisted passenger has `NULL` until promoted. The nullable FK is the waitlist mechanism — no extra table needed, no schema change in Phase 2.

### Step (c) — Error Handling, Response Envelope, Validation Middleware

**One global error handler, zero try/catch in controllers**
`src/middlewares/errorHandler.ts` is the single place that converts thrown errors into HTTP responses. It handles three categories in order: `AppError` subclasses (typed, known errors → correct status + code), `ZodError` (schema.parse() called directly → 400 VALIDATION_ERROR), and `SyntaxError` with a `body` property (malformed JSON body from express.json() → 400 INVALID_JSON). Everything else logs the stack and returns a generic 500 — internals never leak. Result: controllers throw and forget, no error-shaping logic anywhere but this one file.

**`validate(schema, target?)` middleware**
`src/middlewares/validate.ts` exports a factory: `validate(zodSchema)` returns an Express middleware that calls `schema.safeParse(req.body)` (or `req.query` / `req.params` with the optional second argument). On failure it responds 400 immediately with `{ code: 'VALIDATION_ERROR', details: [{field, message}] }` — one entry per failing field, which is what frontend teams actually need to highlight specific inputs. On success it replaces `req.body` with the parsed output, so controllers receive coerced, defaulted, type-safe data. Controllers see only valid input and never call safeParse themselves.

**Why safeParse, not parse**
`schema.parse()` throws a `ZodError` on failure; `schema.safeParse()` returns a result object. Using `safeParse` in the middleware keeps error handling explicit and avoids an extra try/catch. The error handler's ZodError branch is a safety net for any code that calls `parse()` directly — belt and suspenders.

**Machine-readable error codes**
Every error response has a `code` string (`VALIDATION_ERROR`, `SEAT_UNAVAILABLE`, `UNAUTHORIZED`, etc.) in addition to the HTTP status. HTTP status tells you the category; the code tells you exactly what went wrong so the client can branch on it without parsing the message string. This is a small detail that interviewers notice because it shows you've thought about the client side.

### Step (d) — Auth (register, login, JWT middleware)

**bcrypt cost factor 10 — why not higher?**
bcrypt is intentionally slow: cost 10 means ~100ms per hash on a modern CPU. That 100ms is the attacker's cost per brute-force attempt, not just your login latency. Going higher (12+) slows down your own server under load; staying at 10 is the industry default and a defensible answer. The key point for interviews: *never store plaintext, never use a reversible hash like MD5/SHA — only a slow, salted key-derivation function like bcrypt/argon2 is appropriate for passwords.*

**Same error message for wrong email and wrong password**
`authService.login` returns `"Invalid email or password"` for both cases. If you said "email not found" for one and "wrong password" for the other, an attacker could enumerate which emails are registered on your platform. Using a generic message is the correct defence against username enumeration — even though it's slightly less helpful to the user. Good interviewers will ask why.

**JWT payload contains `{ userId, role }` — nothing else**
The token is signed with HS256 and expires in 15 minutes (configurable via `JWT_EXPIRES_IN`). `userId` is the lookup key for the auth middleware; `role` is included so RBAC checks in Phase 3 don't require an extra DB round-trip on every request. No sensitive data (email, passwordHash) goes in the token — tokens are base64-decodable by anyone who holds one.

**`asyncHandler` — zero try/catch in controllers**
`asyncHandler(fn)` wraps an async handler and calls `.catch(next)`, forwarding any rejection to Express's error pipeline. Without this, an unhandled async throw in Express 4 becomes an unhandled promise rejection and crashes the process. With it, every controller is a single `await service.method()` line followed by `sendSuccess` — no error handling noise.

**`requireAuth` uses `next(err)` not `throw`**
Synchronous middleware *can* `throw` in Express 4 (it's caught). But using `next(new UnauthorizedError(...))` explicitly is clearer about intent and consistent across both the sync header check and the try/catch around `jwt.verify`. One pattern, not two.

### Step (e) — Train Search + Train Details

**Availability is computed in two queries, never stored**
`trainRepository.getAvailability` runs two queries: (1) count seats per class by summing each coach's seat count, (2) count passengers with assigned seats in non-cancelled bookings for the same train+date. Available = total − occupied. No `available_count` column exists anywhere. Stored counters need careful increment/decrement on every booking and cancellation — exactly the kind of mutable shared state that creates lost-update bugs. Computing from the bookings table is always authoritative and makes cancellations free (no counter to decrement).

**Weekday filtering uses UTC dates throughout**
`parseDate("2026-07-01")` creates `new Date(Date.UTC(2026, 6, 0))` and `getUTCDay()` returns the weekday. Using the local-time `new Date(year, m-1, d)` would give a different weekday in any UTC+ timezone (e.g. IST UTC+5:30) because midnight local = 6:30pm previous day UTC. Storing run_days as `[0,1,2,3,4,5,6]` (0=Sun, JS convention) and comparing against `getUTCDay()` is timezone-safe.

**`train_stops` table is what makes search work**
The search finds all trains that stop at any of the two station codes, then filters in JavaScript for: (a) source stop exists, (b) destination stop exists, (c) `source.stopOrder < destination.stopOrder`. Without the stops table, you couldn't query intermediate segments at all — you'd have to store a source + destination on each train, which breaks for any user not travelling the full route.

**`@types/express@5` widens `req.params` values to `string | string[]`**
In Express 5's type definitions, `ParamsDictionary` is `{ [key: string]: string | string[] }` (Express 4 was `string` only). Route params are always single strings at runtime, so the cast `req.params.trainNumber as string` is safe — but it's a detail to know when migrating type definitions.

### Step (f) — Booking History + Booking Detail (Read Paths)

**`router.use(requireAuth)` applied once at the router level**
Every booking route is authenticated. Applying `requireAuth` once via `router.use()` is cleaner than repeating it on each individual route — and guarantees no route is accidentally left public. This is a "fail closed" posture: new routes added to the booking router are protected by default without any extra ceremony.

**List vs detail have different response shapes by design**
The history endpoint (`GET /bookings`) uses Prisma `_count` to get the passenger count — it never fetches the passenger rows themselves. This keeps the list response lean (one row per booking) and avoids loading potentially large relation sets just to count them. The detail endpoint (`GET /bookings/:pnr`) fetches full passenger + seat + payment data because you've already drilled in and need everything. This split is what makes list views fast even with many bookings.

**Ownership check happens in the service, not a middleware**
`bookingService.getDetail` fetches the booking by PNR and then checks `booking.userId !== userId`. Doing this in middleware would require a second DB fetch (middleware doesn't know the booking yet). Doing it in the service reuses the fetch that would happen anyway. ADMIN bypass — where admins can view any booking — is deliberately deferred to Phase 3 RBAC; when it arrives, only this one check needs a role-aware branch.

**`journeyDate` serialised as `YYYY-MM-DD` string, never ISO timestamp**
The column is a `DATE` in PostgreSQL (no time component). Serialising with `.toISOString()` would produce `"2026-07-01T00:00:00.000Z"`, which leaks an artificial midnight UTC time. Slicing at `'T'` gives a clean date-only string that matches what the client sent during search — same shape in and out.

### Step (g) — Booking Creation + Cancellation

**Cancellation is `POST /bookings/:pnr/cancel`, not `DELETE /bookings/:pnr`**
Cancellation is a state transition with side-effects (refund, and in Phase 2, waiting-list promotions). Modelling it as `DELETE` implies the resource is destroyed — but bookings are never hard-deleted; they stay as audit history with status `CANCELLED`. A `POST` action route makes the intent explicit and is safer to extend (Phase 2 adds WL promotion logic inside the same action).

**`prisma.$transaction` in the repository, not the service**
The create and cancel transactions are owned by the repository, not the service. The service decides *what* to create; the repository decides *how* to persist it atomically. Calling `prisma.$transaction` in the service would be a Prisma call outside the repository layer — a layering violation. Keeping it in the repository means the service can be unit-tested by mocking the repository, with no Prisma dependency.

**PNR retry loop for uniqueness collisions**
`generatePnr()` produces a random 10-char alphanumeric string. The probability of collision is ~1 in 36^10 (~3.7 trillion) per booking — effectively zero. But the Prisma `P2002` unique-constraint error is caught and retried up to 5 times rather than crashing. This is the correct pattern: design for the overwhelmingly common case, handle the edge case gracefully without over-engineering.

**Fare is computed server-side from distance × class rate × passenger count**
The client never sends a fare amount. The server fetches `distanceKm = toStop.distanceKm - fromStop.distanceKm` from the seed data and multiplies by a fixed rate table (paise per km). Trusting client-sent amounts would allow users to pay whatever they want — computing server-side is the only correct approach. Rates are hardcoded for Phase 1; a `fare_rules` table is future scope.

**Known race condition (intentional — see Phase 4)**
Steps "find free seats" then "create booking" are two separate DB operations with no lock between them. Two concurrent requests can both read the same seat as free and both succeed. This is left in deliberately. Phase 4 fixes it via pessimistic locking (`SELECT … FOR UPDATE`), optimistic locking (the `seats.version` column), and Redis distributed locks — then benchmarks all three. The story "I shipped it naive, reproduced the race, then fixed it three ways" is the strongest thing you can say in a senior backend interview.
