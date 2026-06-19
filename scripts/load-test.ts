/**
 * Phase 4 step (a) — reproduce the shipped double-booking race.
 *
 * Fires N concurrent single-passenger bookings for the SAME train/date/class.
 * The Phase-1/2 booking flow is check-then-act: every concurrent request reads
 * the same seats as free (none has committed yet) and picks the lowest-numbered
 * one — so many passengers get assigned the SAME physical seat. We detect that
 * by counting how many CONFIRMED passengers share a seat.
 *
 * Run against a server with rate limiting OFF (RATE_LIMIT_ENABLED=false),
 * otherwise the limiter masks the race.
 *
 *   BASE, TRAIN, DATE, CLASS, FROM, TO, N  (all overridable via env)
 */
const BASE  = process.env.BASE  ?? 'http://localhost:3000/api/v1';
const TRAIN = process.env.TRAIN ?? '12723';
const DATE  = process.env.DATE  ?? '2026-08-15';
const CLASS = process.env.CLASS ?? '1A';      // 1A = FIRST_A, 18 seats on 12723
const FROM  = process.env.FROM  ?? 'SC';
const TO    = process.env.TO    ?? 'NDLS';
const N     = Number(process.env.N ?? 30);

async function main() {
  const email = `loadtest_${Date.now()}@test.com`;

  await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Load Test', email, password: 'secret123' }),
  });
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' }),
  });
  const token = (await loginRes.json()).data?.accessToken;
  if (!token) throw new Error('login failed — is RATE_LIMIT_ENABLED=false and the server up?');

  const bookOnce = (i: number) =>
    fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        trainNumber: TRAIN, journeyDate: DATE, fromStation: FROM, toStation: TO, classType: CLASS,
        passengers: [{ name: `P${i}`, age: 30, gender: 'M' }],
      }),
    }).then(async (r) => ({ http: r.status, body: await r.json() }));

  console.log(`Firing ${N} concurrent bookings: train ${TRAIN} ${FROM}->${TO} ${DATE} class ${CLASS}\n`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => bookOnce(i)));
  const elapsed = Date.now() - started;

  // ── Tally ────────────────────────────────────────────────────────────────
  const statusCount: Record<string, number> = {};
  const confirmedSeats: string[] = [];
  let httpErrors = 0;

  for (const r of results) {
    if (r.http >= 400) { httpErrors++; statusCount[`HTTP ${r.http}`] = (statusCount[`HTTP ${r.http}`] ?? 0) + 1; continue; }
    for (const p of r.body.data?.passengers ?? []) {
      statusCount[p.status] = (statusCount[p.status] ?? 0) + 1;
      if (p.status === 'CONFIRMED' && p.seat) confirmedSeats.push(p.seat);
    }
  }

  const seatCounts = new Map<string, number>();
  for (const s of confirmedSeats) seatCounts.set(s, (seatCounts.get(s) ?? 0) + 1);
  const doubleBooked = [...seatCounts.entries()].filter(([, c]) => c > 1);
  const worst = Math.max(0, ...seatCounts.values());

  console.log(`Completed ${N} requests in ${elapsed}ms\n`);
  console.log('Status distribution:', statusCount);
  console.log(`\nCONFIRMED passengers:      ${confirmedSeats.length}`);
  console.log(`Distinct seats used:       ${seatCounts.size}`);
  console.log(`Seats with >1 passenger:   ${doubleBooked.length}`);
  console.log(`Worst seat overbooking:    ${worst} passengers on one seat`);

  if (doubleBooked.length > 0) {
    console.log('\n❌ DOUBLE BOOKING REPRODUCED — same physical seat sold to multiple passengers:');
    for (const [seat, c] of doubleBooked.slice(0, 10)) console.log(`   ${seat}  ->  ${c} passengers`);
  } else {
    console.log('\n✅ No double booking detected this run (try a higher N or a fresh DATE).');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
