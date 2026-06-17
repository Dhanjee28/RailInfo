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

## Architecture Decisions — Phase 2

Phase 2 replaces Phase 1's "grab any free seat" with real railway semantics: a seat-allocation algorithm, RAC (Reservation Against Cancellation), a waiting list with positions, a per-passenger state machine, automatic promotions on cancellation, and a public PNR status endpoint. Every schema change is **additive** — no Phase 1 table was rewritten, which was the whole point of the Phase 1 design.

### Step (a) — Coach Class Config + Passenger Position Columns

**`coach_class_configs` table holds the per-class quotas**
One row per `(train_id, class_type)` stores `rac_capacity` (how many RAC passenger slots) and `max_waitlist` (the hard cap beyond which a booking is refused). These are policy numbers, not physical inventory, so they belong in their own configurable table rather than hardcoded in the allocation logic. The allocation algorithm reads this row before accepting any booking.

**`waitlist_position` and `rac_position` are nullable columns on `booking_passengers`**
Exactly one is non-null depending on status: a WAITLISTED passenger has a `waitlist_position`, an RAC passenger has a `rac_position`, a CONFIRMED passenger has neither. No separate queue table — the position *is* a column on the passenger row, which keeps promotion a simple `UPDATE` rather than a cross-table move.

**Deviation from plan: `class_type` column added to `booking_passengers`**
The plan listed only the two position columns. But a WAITLISTED passenger has `seat_id = NULL`, so their travel class can't be inferred from the seat relationship — yet every WL/RAC query must be scoped *by class* (SL waitlist is independent of 2A waitlist). The fix is a nullable `class_type` column on the passenger row, set at booking time. Nullable because pre-Phase-2 confirmed rows predate it; promotion simply skips any passenger with a null class. This was flagged as a deviation and is documented here as the reasoning.

### Step (b) — PassengerStateMachine (the "state machine" interview answer)

**One enforcement point for every status change**
`PassengerStateMachine.transition(from, to)` throws `BadRequestError('INVALID_STATUS_TRANSITION')` unless the move is legal. Legal moves: `WAITLISTED → RAC`, `RAC → CONFIRMED`, and `any → CANCELLED`. Illegal: `WAITLISTED → CONFIRMED` directly (you must step through RAC), any backwards move, and anything out of `CANCELLED` (terminal). Centralising this means the promotion engine, cancellation, and any future code all share one definition of "what's allowed" — you can't accidentally promote a waitlisted passenger straight to confirmed from one code path and not another.

**Why model it explicitly instead of scattering `if` checks**
A booking's lifecycle is a finite-state machine; encoding the legal-transition table as data (`Record<Status, Set<Status>>`) makes the rules auditable at a glance and unit-testable in isolation (14 tests cover every legal and illegal pair). When an interviewer asks "where did you use a state machine?", this is a concrete, defensible answer.

### Step (c) — Seat Allocation Algorithm

**Fill order: CONFIRMED → RAC → WAITLISTED → refuse**
For each passenger the algorithm tries a confirmed seat first; if seats are exhausted it tries an RAC slot; if RAC is full it assigns a waitlist position; if the waitlist is at `max_waitlist` it throws `ConflictError('WAITLIST_FULL')` (409). This mirrors how real reservation works.

**SIDE_LOWER berths are reserved for RAC and excluded from the confirmed pool**
`findFreeSeats` excludes `SIDE_LOWER`; `findRacSeatOccupancy` returns *only* `SIDE_LOWER` seats with their current occupancy. In real Indian Railways, two RAC passengers share one side-lower berth — so RAC capacity is modelled as "2 passengers per side-lower berth", and the algorithm never lets a third passenger onto a berth.

**Seniors (age ≥ 60) are sorted first for LOWER-berth preference**
Passengers are sorted seniors-first before allocation so a senior gets first pick of a `LOWER` berth, then the original order is restored in the result. This matches the real-world lower-berth preference for senior citizens without changing the order the client sees back.

**The check-then-act race now lives in `allocationService`**
Reading free seats and then writing the booking are still two separate steps with no lock — the Phase 1 race condition moved here intact, by design. Rule 5 keeps it until Phase 4.

### Step (d) — Promotion Engine (runs inside the cancellation transaction)

**The cascade: CONFIRMED freed → RAC promoted → WL promoted**
When a confirmed seat is cancelled, the lowest-positioned RAC passenger is promoted to CONFIRMED and takes the freed seat; that vacates their side-lower berth slot, so the lowest-positioned WL passenger is promoted to RAC onto it. Cancelling an RAC slot promotes the top WL passenger directly. Cancelling a WL passenger just closes the gap (decrement positions behind them). Every status change calls `PassengerStateMachine.transition`, so the invariant holds even inside promotion.

**Why it must run inside the cancellation transaction**
A half-applied promotion chain is corruption: a confirmed seat freed but the RAC passenger not promoted leaves a phantom-empty seat and a stuck queue. The repository's `cancelBookingTx` takes an `onCancelled(tx)` callback and runs the promotion inside the same `prisma.$transaction` as the cancel — atomic by construction. This is the "how do you keep a multi-step operation consistent?" interview answer: transaction boundaries.

**Positions are decremented behind the change, not fully recomputed**
Promotion shifts only the positions *greater than* the freed one (`updateMany … position > N → decrement 1`), rather than re-numbering the whole queue. Cheaper, and the promotion *decision* always re-queries the lowest live position via `orderBy position asc`, so even if numbers briefly have gaps the right passenger is always next.

**Known limitation (documented):** cancelling a whole booking that mixes CONFIRMED + RAC passengers can make the *displayed* RAC numbers drift by one, because each passenger's pre-cancel position goes stale after the previous one in the same cancel renumbers. It's cosmetic — promotion decisions stay correct since queries pick the lowest live position. Candidate for tightening when the allocation/promotion code is rewritten.

### Step (e) — Public PNR Status Endpoint

**`GET /api/v1/pnr/:pnr` is public — no auth, like real IRCTC**
Anyone with a PNR can check its status; that's how the real system works. It's a separate router from `/bookings` (which is fail-closed behind `requireAuth`) precisely so it stays outside the auth wall. It also uses a dedicated `findByPnrPublic` repository method that omits payment details — a public status check has no business returning payment rows.

**Berth string formatted per status**
The response formats each passenger as IRCTC does: `S2/34 LOWER` when confirmed, `RAC 3` when RAC, `WL 7` when waitlisted. The formatting lives in the controller (an HTTP-presentation concern), not the service.

### Step (f) — Wiring Allocation + Promotion into Booking Flows

**`createBookingTx` now persists per-passenger status, seat, and positions**
A booking is no longer uniformly CONFIRMED — it can be CONFIRMED, RAC, WAITLISTED, or `PARTIALLY_CONFIRMED` (a mix). The booking-level status is derived from the set of passenger statuses. This is exactly the per-passenger-status schema decision from Phase 1 paying off: zero rewrite, just richer data in the same columns.

**Cancellation orders passengers CONFIRMED → RAC → WAITLISTED before promoting**
Freeing confirmed seats first triggers the longest promotion chains, so they're processed first. The service captures each passenger's *pre-cancel* state (the cancel itself flips the rows to CANCELLED), then runs the promotion for each inside the transaction callback.

### Step (g) — Edge-Case Tests

**30 unit tests, no database required**
`allocationService` is tested by mocking its repository; `promotionService` by passing a fully-mocked transaction client. Coverage matches the plan's edge-case list: RAC 2-per-berth sharing (never a 3rd), `racCapacity` cap, CNF+RAC+WL → `PARTIALLY_CONFIRMED`, waitlist position continuation, `WAITLIST_FULL` 409, the full RAC→CNF→WL promotion cascade, waitlist gap-closing, and the side-lower berth guard. Because both services are pure logic over injected dependencies, the tests are fast and deterministic.

### Cross-cutting fix — unique `(coach_id, seat_number)` on `seats`

**A non-idempotent seed had duplicated every physical seat**
The seed used `createMany({ skipDuplicates: true })`, but `skipDuplicates` only skips rows that violate a **unique constraint** — and `seats` had none on `(coach_id, seat_number)`. So each re-run inserted a fresh set of seats with new UUIDs, silently doubling inventory. Allocation then handed out two distinct rows that were really the same physical seat. Adding `@@unique([coachId, seatNumber])` makes the seed genuinely idempotent and prevents recurrence. Lesson worth stating in interviews: *`skipDuplicates` is a no-op without a constraint to act on — idempotency must be enforced by the schema, not assumed by the loader.*

## Architecture Decisions — Phase 3

Phase 3 adds no new business logic — it makes the backend operate like something a company runs: hardened auth, RBAC, caching, rate limiting, structured logging, containerization, and API docs.

### Step (a) — Refresh tokens (rotation + reuse detection)

**Access token short, refresh token long — two different jobs**
The access token stays a 15-min JWT (stateless, carries `{userId, role}`). A new opaque 256-bit refresh token (7-day) is issued at login in an httpOnly, `SameSite=strict`, path-scoped (`/api/v1/auth`) cookie. The split is the standard tradeoff: short access tokens limit the blast radius of a leak without forcing the user to log in constantly, because the refresh token silently mints new ones.

**Why SHA-256 the refresh token, not bcrypt**
Only the token's SHA-256 hash is stored, so a DB leak exposes no usable tokens. SHA-256 (fast) is correct here precisely because the token is already 256 bits of entropy — bcrypt's deliberate slowness only buys security for *low-entropy* secrets like human passwords. Using bcrypt here would be cargo-culting.

**Rotation + reuse detection = theft response**
Every refresh revokes the presented token and issues a new one in the same `family_id`. A correctly-behaving client never presents a rotated token twice — so if an already-revoked token is presented, that's a theft signal: the whole family is revoked (forcing re-login). This turns token rotation from a nicety into an active intrusion-detection mechanism.

**No access-token blacklist**
Logout revokes the refresh token; the access token simply expires within 15 min. A per-request blacklist would re-introduce the statefulness JWTs exist to avoid. Naming the 15-min window as the accepted cost — rather than over-engineering a blacklist — is the senior answer.

### Step (b) — RBAC

**`requireRole('ADMIN')` trusts the signed JWT claim**
The role lives in the JWT; the middleware checks `req.user.role` with no DB round-trip, because the token is tamper-proof (HS256-signed). A DB re-verification would only matter if immediate role-revocation were required — the same 15-min staleness tradeoff as the access token, documented in the middleware. Stacked *after* `requireAuth` and applied once at the router level, so every admin route is fail-closed.

**Seat generation extracted to one source of truth**
`src/domain/seatLayout.ts` holds the berth pattern; both the seed and `POST /admin/coaches` use it, so a manually-added coach is laid out identically to a seeded one.

### Step (c) — Redis cache-aside

**There is no universal caching strategy — choose per key**
- **TTL-only** (`search:{src}:{dst}:{date}`, 60s): a broad listing where bounded staleness is acceptable.
- **TTL + explicit invalidation** (`train:{number}` 1h, `stations:all` 24h): rarely changes, must be correct right after an admin edit — so the admin write `DEL`s the key.
- **Refuse to cache** (seat availability, PNR status): correctness in the money path beats speed; stale availability means failed bookings. Train *detail* caches only the **static route** — availability is recomputed live on every request and never stored.

**Caching is an optimisation, never a correctness dependency**
The Redis client uses `enableOfflineQueue: false` + bounded retry, and every cache call is wrapped so a Redis outage falls straight through to the database. The cache also never stores `null`, so a one-off miss can't poison a key with a negative entry that outlives a later create.

### Step (d) — Rate limiting

**Sliding-window counter, in Redis, evaluated atomically**
Two fixed sub-windows (current + previous) with the trailing count estimated as `current + previous × (fraction of window remaining)`. This approximates a true sliding window at a fraction of the cost of a sliding *log* (which stores every request timestamp) — be ready to compare fixed-window, sliding-log, sliding-counter, and token-bucket. The check + increment run in one Lua script so they're atomic.

**Redis-backed, not in-memory — and it fails open**
In-memory counters reset per instance: with N app instances an attacker gets N× the limit. A shared Redis store enforces one global limit. But if Redis is unreachable the limiter *allows* the request (fails open) — a rate limiter must never take down the API. Tiers: global 100/min/IP, login 5/min/IP (credential stuffing), register 3/hour/IP (spam), bookings 10/min/user. Blocks return 429 + `Retry-After`.

### Step (e) — Structured logging + request correlation

**`requestId` via AsyncLocalStorage — correlation with zero plumbing**
A middleware seeds a per-request UUID into an `AsyncLocalStorage` store and echoes it as the `X-Request-Id` header. The pino logger's `mixin` reads that store on every line, so *all* logs emitted while handling a request — across services, repositories, anywhere — carry the same `requestId`, without threading it through a single function signature. Correlation is the thing that makes production debugging possible.

**Redact at the logger, silent in tests**
A `redact` list strips passwords/tokens/authorization headers from any log payload. The logger is `silent` under `NODE_ENV=test` so unit-test output stays clean and no log handle leaks. State changes (`booking created`, `booking cancelled`, `passenger promoted`) are logged for an audit trail.

### Step (f) — Docker

**Multi-stage build, slim non-root runtime**
The `builder` stage carries the full toolchain (compiles TS, generates the Prisma client); the `runtime` stage is `node:20-alpine` with production deps only, the compiled `dist`, the generated Prisma client, and a non-root `nodejs` user — ~127 MB. `apk add openssl` in both stages because Prisma's engine needs it on alpine.

**A one-shot migration job, not migrations-in-the-app**
A dedicated `migrate` compose service (built from the `builder` stage, so it has the Prisma CLI + ts-node) runs `migrate deploy` + seed then exits; the `app` waits on `condition: service_completed_successfully`. This keeps the runtime image free of dev tooling while still giving a one-command, seeded demo. Healthchecks (`pg_isready`, `redis-cli ping`, `wget /health`) gate startup order via `depends_on: condition: service_healthy`.

### Step (g) — OpenAPI / Swagger from Zod

**Docs generated from the validators — they can't drift**
`@asteasolutions/zod-to-openapi` builds the OpenAPI 3.0 spec from the *same* Zod schemas `validate()` enforces, served via Swagger UI at `/api/docs`. The `classType` enum, `passengers` max of 6, and password min-length appear in the docs automatically because they *are* the validation rules — there's no second hand-maintained description to fall out of sync.
