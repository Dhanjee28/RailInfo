# Project Progress Log

Living log of everything built, step by step. Updated on completion of every step/phase.
For the *why* behind decisions, see the "Architecture Decisions" sections in [README.md](README.md).

**Stack:** Node.js · TypeScript · Express · PostgreSQL · Prisma · Redis · Docker · JWT · Zod · bcrypt
**Architecture:** Routes → Controllers → Services → Repositories · `{success,data}` / `{success,error}` envelope · custom `AppError` + global error handler · Zod validation · availability always computed, never stored.

**Legend:** ✅ done & verified · 🔸 code complete, not yet committed · ⬜ not started

---

## Phase 1 — Core Booking MVP — ✅ COMPLETE

| Step | What | Status |
|------|------|--------|
| a | Project setup (layered structure, env validation, AppError, logger) | ✅ |
| b | Prisma schema (8 tables) + migration + seed | ✅ |
| c | Error handling, response envelope, Zod `validate` middleware | ✅ |
| d | Auth — register, login, JWT, `requireAuth` middleware | ✅ |
| e | Train search + train details (computed availability) | ✅ |
| f | Booking history + detail (read paths) | ✅ |
| g | Booking creation + cancellation (atomic transactions) | ✅ |

**Highlights:** bcrypt cost 10, JWT `{userId, role}` 15-min, PNR gen + retry, server-side fare, soft-cancel (audit), forward-compat columns planted (`seats.version`, `payments.idempotency_key`, nullable `seat_id`, per-passenger status). Known check-then-act race **intentionally left in** → fixed in Phase 4.

---

## Phase 2 — Railway Logic (Allocation / RAC / Waitlist / PNR) — ✅ COMPLETE (30 unit tests green)

| Step | What | Status |
|------|------|--------|
| a | `coach_class_configs` table + `waitlist_position`/`rac_position` columns + seed config | ✅ |
| b | `PassengerStateMachine` + 14 unit tests | ✅ |
| c | `allocation.repository.ts` + `allocation.service.ts` | ✅ |
| d | `promotion.service.ts` (cancellation cascade) | ✅ |
| e | `GET /api/v1/pnr/:pnr` public endpoint | ✅ |
| f | Wired allocation + promotion into booking create/cancel | ✅ |
| g | Edge-case unit tests (allocation 10 + promotion 6) | ✅ |

**Highlights:**
- Allocation fill order CONFIRMED → RAC → WAITLISTED → `WAITLIST_FULL` (409); SIDE_LOWER reserved for RAC (2 share a berth); seniors (≥60) get LOWER preference.
- Promotion runs **inside the cancel transaction**: CONFIRMED-freed → top RAC promoted to CNF → top WL promoted to RAC; positions decremented behind the change.
- Booking can be `PARTIALLY_CONFIRMED` (per-passenger status payoff from Phase 1).
- **Schema deviation:** nullable `class_type` added to `booking_passengers` (WL passengers have no seat → class not inferable from seat).
- **Bug fixed:** `@@unique([coachId, seatNumber])` on seats — a non-idempotent seed had duplicated every seat (2432 → 1216).
- **Rule 4 markers:** `allocation.service.ts`, `promotion.service.ts`, `booking.service.ts` create/cancel carry `// TODO(DJ): rewrite yourself before interviews`.

---

## Phase 3 — Production Features — ✅ COMPLETE (quiz skipped per DJ)

### (a) Refresh tokens + rotation + reuse detection — ✅
**Files:** `prisma/schema.prisma` (RefreshToken model + migration), `src/utils/tokens.ts`, `src/repositories/refreshToken.repository.ts`, `src/services/auth.service.ts`, `src/controllers/auth.controller.ts`, `src/routes/auth.routes.ts`, `src/config/env.ts`, `src/app.ts` (cookie-parser), `.env.example`.
- `refresh_tokens` table: SHA-256 hash stored (not raw), `family_id`, `expires_at`, `revoked_at`.
- Login issues opaque 256-bit refresh token via httpOnly, `SameSite=strict`, path-scoped cookie.
- `POST /auth/refresh` rotates (revoke old, issue new in same family); reuse of a revoked token → revoke whole family + 401.
- `POST /auth/logout` revokes + clears cookie.
- **Verified:** rotation, reuse detection cascading to family, logout.

### (b) RBAC + admin endpoints — ✅
**Files:** `src/middlewares/auth.ts` (`requireRole`), `src/validators/admin.validators.ts`, `src/repositories/admin.repository.ts`, `src/services/admin.service.ts`, `src/controllers/admin.controller.ts`, `src/routes/admin.routes.ts`, `src/domain/seatLayout.ts` (extracted), `prisma/seed.ts` (admin user), `src/app.ts`.
- `requireRole('ADMIN')` trusts signed JWT claim, stacked after `requireAuth`.
- `POST /admin/stations`, `POST /admin/trains` (+ stops, atomic), `PATCH /admin/trains/:trainNumber`, `POST /admin/coaches` (+ auto-generated seats).
- Seed creates admin: `admin@railinfor.test` / `admin12345`.
- **Verified:** no-token 401, user 403, admin 201/200, duplicate 409, unknown-station 400.

### (c) Redis cache-aside — ✅
**Files:** `src/config/redis.ts`, `src/utils/cache.ts`, `src/repositories/station.repository.ts`, `src/services/station.service.ts`, `src/controllers/station.controller.ts`, `src/routes/station.routes.ts`, `src/repositories/train.repository.ts` (`findStaticByNumber`), `src/services/train.service.ts`, `src/services/admin.service.ts` (invalidation), `docker-compose.yml` (redis), `src/config/env.ts`, `.env.example`.
- Resilient ioredis client (fails through to DB if Redis down); `cacheAside`/`cacheDel` helpers; never caches null.
- Cached: `search:{src}:{dst}:{date}` (60s), `train:{number}` (1h, **static route only**), `stations:all` (24h) + new public `GET /stations`.
- Invalidation: admin train update → `DEL train:{number}`; admin station create → `DEL stations:all`.
- **Deliberately NOT cached:** availability + PNR (money-path correctness).
- **Verified:** keys populate, cached detail has no availability, both invalidations work live.

### (d) Rate limiter — 🔸 (code complete + verified, DJ to commit)
**Files:** `src/middlewares/rateLimit.ts` (new), `src/errors/AppError.ts` (`TooManyRequestsError`), `src/app.ts` (global), `src/routes/auth.routes.ts`, `src/routes/booking.routes.ts`.
- Redis sliding-window-counter (Lua, atomic); fails **open** if Redis down.
- Tiers: global 100/min/IP · login 5/min/IP · register 3/hour/IP · bookings 10/min/user.
- 429 + `Retry-After`. **Verified:** 6th login within a minute → 429, `Retry-After: 54`.

### (e) Structured logging + requestId correlation — 🔸 (code complete + verified, DJ to commit)
**Files:** `src/utils/logger.ts` (rewritten on pino), `src/utils/requestContext.ts` (new, AsyncLocalStorage), `src/middlewares/requestLogger.ts` (new), `src/app.ts` (mounted first), `src/config/env.ts` (`LOG_LEVEL`), `src/services/booking.service.ts` (create/cancel logs), `src/services/promotion.service.ts` (promotion logs).
- pino JSON logger; a `mixin` pulls `requestId` from AsyncLocalStorage so every line within a request is auto-correlated — no plumbing.
- `requestLogger` seeds a UUID per request, sets `X-Request-Id` header, logs one `request completed` line (method/path/status/durationMs) at a severity matching the status class.
- `redact` strips passwords/tokens/authorization. Logger is `silent` under `NODE_ENV=test`.
- State-change logs: `booking created`, `booking cancelled`, `passenger promoted`.
- **Verified:** booking-created log and request-completed log share the same requestId; startup logs have none; header matches.

### (f) Multi-stage Dockerfile + full docker-compose — 🔸 (built + verified, DJ to commit)
**Files:** `Dockerfile` (new), `.dockerignore` (new), `docker-compose.yml` (app + migrate + healthchecks).
- Multi-stage: `builder` (full toolchain, `prisma generate`, `tsc`) → `runtime` (slim `node:20-alpine`, prod deps only, **non-root `nodejs` user**, ~127 MB). `apk add openssl` in both (Prisma engine needs it on alpine).
- One-shot `migrate` service (built from `builder`, has prisma CLI + ts-node) runs `migrate deploy` + seed, then exits; `app` waits on `condition: service_completed_successfully`.
- Healthchecks: postgres `pg_isready`, redis `redis-cli ping`, app `wget /health`; `depends_on` gates startup on health.
- **Verified:** `docker compose up --build` → migrate exits 0 (seeded), app healthy, container user `nodejs`, live `/health` + admin login + search all work.

### (g) OpenAPI/Swagger from Zod — 🔸 (code complete + verified, DJ to commit)
**Files:** `src/docs/openapi.ts` (new), `src/app.ts` (serve docs).
- `@asteasolutions/zod-to-openapi` v7 (zod-3 compatible) builds an OpenAPI 3.0 doc from the **same Zod validators** the API enforces → docs can't drift from validation. `swagger-ui-express` serves it.
- `GET /api/docs` (Swagger UI) + `GET /api/docs.json` (raw spec). 15 paths / 16 operations across Auth, Trains, Stations, PNR, Bookings, Admin; `bearerAuth` security scheme.
- **Verified:** doc generates, UI renders 200, and Zod constraints surface in the spec (classType enum SL/3A/2A/1A, passengers maxItems 6, password minLength 8).

### (h) Clean-stack verification — ✅
- `docker compose down -v` then `docker compose up --build` from wiped volumes.
- Verified: migrate applied ALL migrations from scratch + seeded; app healthy; `/health`, `/api/docs` (200), `/api/docs.json` (15 paths), `GET /stations` (10), admin login, and a full register→login→book→PNR round-trip (senior → S1/1 LOWER) all work through the container.
- Phase quiz skipped per DJ (taken on claude.ai).

**Outstanding housekeeping:** README "Architecture Decisions — Phase 3" section ✅ written. 2 high-severity npm audit vulns still to review.

---

## Phase 4 — Concurrency (the differentiator) — ✅ COMPLETE (quiz skipped per DJ)
Reproduce the shipped race under load, fix 3 ways (pessimistic `SELECT FOR UPDATE` / optimistic `version` / Redis lock) + benchmark, partial unique index safety-net, idempotent payments. **All locking + idempotency code is DJ's to write (rule 4).** Claude does a/e/f (load test, safety-net migration, benchmark+ADR).

### (a) Reproduce the double-booking — 🔸 (Claude; verified)
**Files:** `scripts/load-test.ts` (new), `src/config/env.ts` (`RATE_LIMIT_ENABLED`), `src/middlewares/rateLimit.ts` (bypass when disabled).
- Load script fires N concurrent single-passenger bookings for the same train/date/class and detects how many CONFIRMED passengers share a seat. Run with `RATE_LIMIT_ENABLED=false` (limiter is orthogonal and would mask the race).
- **Result (baseline / "before"):** 30 concurrent 1A bookings on a fresh date → **30/30 CONFIRMED, all on seat `H1/1 LOWER`** — one seat sold 30×. Goes in the README benchmark table at step (f).

### (b) Pessimistic locking — 🔸 (written by Claude at DJ's insistence, TODO(DJ) marker; verified)
**Files:** `src/domain/allocation.ts` (new — pure `allocatePassengers` core extracted), `src/services/allocation.service.ts` (delegates to domain; now the NAIVE read path), `src/repositories/allocation.repository.ts` (reads accept a tx client), `src/repositories/booking.repository.ts` (`createBookingWithLock`), `src/services/booking.service.ts` (create uses the locked path).
- Locks all train+class seat rows `FOR UPDATE` (raw SQL, ascending id → deadlock-free) at the start of the booking tx, then re-reads occupancy and allocates + writes inside the same tx.
- **Result:** 30 concurrent 1A bookings → 18 CONFIRMED (= capacity) + 12 WAITLISTED, **0 double-booking** (was 30× on one seat). Latency 599ms→2590ms (serialization cost — goes in the benchmark).

### (c) Optimistic locking — 🔸 (written by Claude at DJ's insistence, TODO(DJ) marker; verified)
**Files:** `src/config/env.ts` (`LOCK_STRATEGY` env), `src/services/booking.service.ts` (strategy dispatch), `src/repositories/allocation.repository.ts` (RAC reads now expose `version`), `src/repositories/booking.repository.ts` (`createBookingOptimistic`).
- No upfront lock: read seats + `version` in ONE `RepeatableRead` snapshot, allocate, then guard each claimed seat with a raw `UPDATE seats SET version=version+1 WHERE id=? AND version=?`; 0 rows ⇒ lost the race ⇒ retry (jittered, max 5) ⇒ 409 `SEAT_CONTENTION`.
- **Two bugs found + fixed during verification:** (1) Prisma `updateMany` lost the version predicate → switched to raw `$executeRaw`; (2) snapshot skew — `findFreeSeats`' two internal queries straddled a competitor's commit, reporting a seat free with an already-incremented version → wrapped reads in a `RepeatableRead` tx. `seats.id` is TEXT not uuid (no `::uuid` cast).
- **Result:** 30 concurrent 1A → 6 CONFIRMED (distinct) + 24×409, **0 double-booking**. High 409 rate is the optimistic tradeoff under heavy contention (vs pessimistic filling all 18) — goes in the benchmark.
- Switch strategies via `LOCK_STRATEGY=pessimistic|optimistic`.

### (d) Redis distributed lock — 🔸 (written by Claude at DJ's insistence, TODO(DJ) marker; verified)
**Files:** `src/utils/redisLock.ts` (new), `src/repositories/booking.repository.ts` (`createBookingNoSeatLock`), `src/config/env.ts` (`redis` strategy), `src/services/booking.service.ts` (dispatch).
- `withRedisLock(key, ttl, fn)`: `SET lock:booking:{train}:{date}:{class} {token} NX PX 5000` with bounded spin-acquire; release via compare-and-delete Lua (only the holder deletes). Inside the lock the write needs no DB lock (`createBookingNoSeatLock`).
- **Result:** 30 concurrent 1A → 18 CONFIRMED + 12 WAITLISTED, **0 double-booking** (~2138ms). Coarse (whole-class) lock → clean serialization like pessimistic.
- Documented limits: single-node Redis lock not bulletproof (TTL expiry mid-tx → DB safety net in step e); Redlock + Kleppmann-vs-antirez debate noted in the file.

**Benchmark so far (30 concurrent 1A, 18 seats, fresh date):**
| Strategy | CONFIRMED | Failures | ~Time |
|---|---|---|---|
| (before) none | 30 (all seat H1/1) | 0 | 599ms |
| pessimistic | 18 + 12 WL | 0 | 2590ms |
| optimistic | 6 | 24× 409 | 1568ms |
| redis | 18 + 12 WL | 0 | 2138ms |

### (e) Safety-net partial unique index — 🔸 (Claude; verified)
**Files:** `prisma/schema.prisma` (denormalized `journeyDate` on BookingPassenger), `prisma/migrations/20260618100000_phase4_seat_safety_net/migration.sql`, `src/repositories/booking.repository.ts` (all create paths set `journeyDate`).
- `CREATE UNIQUE INDEX … ON booking_passengers (seat_id, journey_date) WHERE status='CONFIRMED'` — DB-level guarantee a seat can't be confirmed twice per date. Partial: excludes RAC (shared berth) + WL/CANCELLED. `journey_date` denormalized (index must be single-table; a seat is reusable across dates).
- DB was `migrate reset` (the load-test double-bookings would have violated the index). **Verified:** a manual duplicate-confirmed INSERT is rejected by the DB.
- Note: a seat-unique violation surfaces as P2002 like a PNR collision; the create retry loop re-allocates on retry, so it degrades gracefully (no corruption). Could refine to inspect the constraint name.

### (f) Benchmark + ADR — 🔸 (Claude)
**Files:** `README.md` ("Architecture Decisions — Phase 4").
- Documents the race + reproduction, READ COMMITTED rationale, all three fixes, the benchmark table, the safety net, the ADR (default = pessimistic + DB index; when to switch), and the 10k-users answer.

### (g) Idempotent payments — 🔸 (written by Claude at DJ's insistence, TODO(DJ) marker; verified)
**Files:** `src/validators/payment.validators.ts`, `src/repositories/payment.repository.ts`, `src/services/payment.service.ts` (marker), `src/controllers/payment.controller.ts`, `src/routes/payment.routes.ts`, `src/app.ts` (mount `/api/v1/payments`), `scripts/idempotency-test.ts`.
- `POST /payments` with `Idempotency-Key` header (server charges the booking fare, not a client amount). key seen+terminal → replay; key+in-flight → 409 PROCESSING; new → insert PENDING (unique key) → execute → SUCCESS. Concurrent identical retries resolved by the unique `idempotency_key` index (one INSERT wins, loser reads winner).
- **Verified:** replay returns same paymentId; missing key → 400; 8 concurrent retries → 1 payment + 7 replays + 1 PROCESSING (no double charge).

Phase 4 quiz skipped per DJ. README "Architecture Decisions — Phase 4" covers everything incl. idempotency + transaction boundaries.

---

*Last updated: 2026-06-19 — Phase 4 COMPLETE (step g: idempotent payments).*
