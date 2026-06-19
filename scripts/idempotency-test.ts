/**
 * Phase 4 step (g) — concurrent-retry test for idempotent payments.
 * Fires N simultaneous POST /payments with the SAME Idempotency-Key and asserts
 * that at most ONE payment is created (no double charge): every successful
 * response shares one paymentId; losers may get 409 PROCESSING.
 */
const BASE = process.env.BASE ?? 'http://localhost:3000/api/v1';
const N    = Number(process.env.N ?? 8);

async function main() {
  const email = `idem_${Date.now()}@test.com`;
  await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Idem Tester', email, password: 'secret123' }) });
  const token = (await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret123' }) })).json()).data.accessToken;

  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const pnr = (await (await fetch(`${BASE}/bookings`, { method: 'POST', headers: auth, body: JSON.stringify({ trainNumber: '12723', journeyDate: '2027-05-05', fromStation: 'SC', toStation: 'NDLS', classType: '2A', passengers: [{ name: 'Pax One', age: 30, gender: 'M' }] }) })).json()).data.pnr;

  const key = `retry-${Date.now()}`;
  const pay = () => fetch(`${BASE}/payments`, {
    method: 'POST',
    headers: { ...auth, 'Idempotency-Key': key },
    body: JSON.stringify({ pnr }),
  }).then(async (r) => ({ http: r.status, body: await r.json() }));

  console.log(`Firing ${N} concurrent payments with the same Idempotency-Key…\n`);
  const results = await Promise.all(Array.from({ length: N }, pay));

  const paymentIds = new Set<string>();
  const statusTally: Record<string, number> = {};
  for (const r of results) {
    const label = r.http >= 400 ? `${r.http} ${r.body?.error?.code}` : `200 ${r.body?.data?.status}`;
    statusTally[label] = (statusTally[label] ?? 0) + 1;
    if (r.http < 400 && r.body?.data?.paymentId) paymentIds.add(r.body.data.paymentId);
  }

  console.log('responses:', statusTally);
  console.log('distinct paymentIds created:', paymentIds.size, [...paymentIds]);
  console.log(paymentIds.size <= 1 ? '\n✅ No double charge — at most one payment exists for the key.' : '\n❌ DOUBLE CHARGE — multiple payments created for one key.');
}

main().catch((e) => { console.error(e); process.exit(1); });
