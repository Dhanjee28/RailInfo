import { PrismaClient, BerthType } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Seat layout helpers ───────────────────────────────────────────────────────
// Prisma enum names use the Prisma-side name (THREE_A, not "3A").
// @map("3A") only affects the PostgreSQL enum value stored in the DB.

const BERTH_PATTERN: Record<string, BerthType[]> = {
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
  TWO_A: [BerthType.LOWER, BerthType.UPPER, BerthType.SIDE_LOWER, BerthType.SIDE_UPPER],
  FIRST_A: [BerthType.LOWER, BerthType.UPPER],
};

const SEAT_COUNT: Record<string, number> = {
  SL: 72, THREE_A: 64, TWO_A: 46, FIRST_A: 18,
};

function seatRows(coachId: string, classType: string) {
  const count = SEAT_COUNT[classType];
  const pattern = BERTH_PATTERN[classType];
  return Array.from({ length: count }, (_, i) => ({
    coachId,
    seatNumber: i + 1,
    berthType: pattern[i % pattern.length],
    version: 0,
  }));
}

// ─── Main seed ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding database…');

  // ── Stations ──────────────────────────────────────────────────────────────
  const stationData = [
    { code: 'NDLS', name: 'New Delhi',       city: 'Delhi'       },
    { code: 'SC',   name: 'Secunderabad',    city: 'Hyderabad'   },
    { code: 'NGP',  name: 'Nagpur Junction', city: 'Nagpur'      },
    { code: 'BPL',  name: 'Bhopal Junction', city: 'Bhopal'      },
    { code: 'AGC',  name: 'Agra Cantt',      city: 'Agra'        },
    { code: 'MAS',  name: 'Chennai Central', city: 'Chennai'     },
    { code: 'BZA',  name: 'Vijayawada Jn',   city: 'Vijayawada'  },
    { code: 'CSTM', name: 'Mumbai CST',      city: 'Mumbai'      },
    { code: 'BRC',  name: 'Vadodara Jn',     city: 'Vadodara'    },
    { code: 'RTM',  name: 'Ratlam Junction', city: 'Ratlam'      },
  ];

  for (const s of stationData) {
    await prisma.station.upsert({ where: { code: s.code }, update: {}, create: s });
  }
  console.log(`  ✓ ${stationData.length} stations`);

  const stations = await prisma.station.findMany();
  const sid = Object.fromEntries(stations.map((st) => [st.code, st.id]));

  // ── Helper: upsert a coach and create its seats ────────────────────────────
  async function upsertCoach(trainId: string, coachNumber: string, classType: string) {
    const coach = await prisma.coach.upsert({
      where: { trainId_coachNumber: { trainId, coachNumber } },
      update: {},
      create: {
        trainId,
        coachNumber,
        // Cast is safe: classType strings are validated by our coach definitions below
        classType: classType as Parameters<typeof prisma.coach.create>[0]['data']['classType'],
      },
    });
    // skipDuplicates makes re-running the seed safe
    await prisma.seat.createMany({ data: seatRows(coach.id, classType), skipDuplicates: true });
    return coach;
  }

  // ── Train 1: 12723 Telangana Express (SC → NDLS, daily) ───────────────────
  const telangana = await prisma.train.upsert({
    where: { trainNumber: '12723' },
    update: {},
    create: { trainNumber: '12723', name: 'Telangana Express', runDays: [0,1,2,3,4,5,6] },
  });

  await prisma.trainStop.createMany({
    skipDuplicates: true,
    data: [
      { trainId: telangana.id, stationId: sid['SC'],   stopOrder: 1, arrivalTime: null,    departureTime: '06:00', dayOffset: 0, distanceKm: 0    },
      { trainId: telangana.id, stationId: sid['NGP'],  stopOrder: 2, arrivalTime: '13:10', departureTime: '13:25', dayOffset: 0, distanceKm: 503  },
      { trainId: telangana.id, stationId: sid['BPL'],  stopOrder: 3, arrivalTime: '18:30', departureTime: '18:50', dayOffset: 0, distanceKm: 853  },
      { trainId: telangana.id, stationId: sid['AGC'],  stopOrder: 4, arrivalTime: '23:00', departureTime: '23:10', dayOffset: 0, distanceKm: 1259 },
      { trainId: telangana.id, stationId: sid['NDLS'], stopOrder: 5, arrivalTime: '05:45', departureTime: null,    dayOffset: 1, distanceKm: 1459 },
    ],
  });

  for (const [coachNumber, classType] of [
    ['S1','SL'], ['S2','SL'], ['S3','SL'], ['S4','SL'],
    ['B1','THREE_A'], ['B2','THREE_A'],
    ['A1','TWO_A'],
    ['H1','FIRST_A'],
  ]) {
    await upsertCoach(telangana.id, coachNumber, classType);
  }
  console.log('  ✓ 12723 Telangana Express');

  // ── Train 2: 12621 Tamil Nadu Express (MAS → NDLS, daily) ─────────────────
  const tamilNadu = await prisma.train.upsert({
    where: { trainNumber: '12621' },
    update: {},
    create: { trainNumber: '12621', name: 'Tamil Nadu Express', runDays: [0,1,2,3,4,5,6] },
  });

  await prisma.trainStop.createMany({
    skipDuplicates: true,
    data: [
      { trainId: tamilNadu.id, stationId: sid['MAS'],  stopOrder: 1, arrivalTime: null,    departureTime: '22:00', dayOffset: 0, distanceKm: 0    },
      { trainId: tamilNadu.id, stationId: sid['BZA'],  stopOrder: 2, arrivalTime: '05:30', departureTime: '05:45', dayOffset: 1, distanceKm: 432  },
      { trainId: tamilNadu.id, stationId: sid['NGP'],  stopOrder: 3, arrivalTime: '14:15', departureTime: '14:25', dayOffset: 1, distanceKm: 858  },
      { trainId: tamilNadu.id, stationId: sid['BPL'],  stopOrder: 4, arrivalTime: '20:00', departureTime: '20:20', dayOffset: 1, distanceKm: 1208 },
      { trainId: tamilNadu.id, stationId: sid['NDLS'], stopOrder: 5, arrivalTime: '07:10', departureTime: null,    dayOffset: 2, distanceKm: 1910 },
    ],
  });

  for (const [coachNumber, classType] of [
    ['S1','SL'], ['S2','SL'], ['S3','SL'], ['S4','SL'],
    ['B1','THREE_A'], ['B2','THREE_A'],
    ['A1','TWO_A'],
    ['H1','FIRST_A'],
  ]) {
    await upsertCoach(tamilNadu.id, coachNumber, classType);
  }
  console.log('  ✓ 12621 Tamil Nadu Express');

  // ── Train 3: 12951 Mumbai Rajdhani (CSTM → NDLS, Mon/Wed/Thu/Fri) ─────────
  const rajdhani = await prisma.train.upsert({
    where: { trainNumber: '12951' },
    update: {},
    create: { trainNumber: '12951', name: 'Mumbai Rajdhani', runDays: [1,3,4,5] },
  });

  await prisma.trainStop.createMany({
    skipDuplicates: true,
    data: [
      { trainId: rajdhani.id, stationId: sid['CSTM'], stopOrder: 1, arrivalTime: null,    departureTime: '16:35', dayOffset: 0, distanceKm: 0    },
      { trainId: rajdhani.id, stationId: sid['BRC'],  stopOrder: 2, arrivalTime: '21:05', departureTime: '21:10', dayOffset: 0, distanceKm: 493  },
      { trainId: rajdhani.id, stationId: sid['RTM'],  stopOrder: 3, arrivalTime: '23:30', departureTime: '23:35', dayOffset: 0, distanceKm: 689  },
      { trainId: rajdhani.id, stationId: sid['AGC'],  stopOrder: 4, arrivalTime: '05:00', departureTime: '05:05', dayOffset: 1, distanceKm: 1103 },
      { trainId: rajdhani.id, stationId: sid['NDLS'], stopOrder: 5, arrivalTime: '08:35', departureTime: null,    dayOffset: 1, distanceKm: 1303 },
    ],
  });

  // Rajdhani has no Sleeper; AC-only
  for (const [coachNumber, classType] of [
    ['B1','THREE_A'], ['B2','THREE_A'],
    ['A1','TWO_A'],   ['A2','TWO_A'],
    ['H1','FIRST_A'], ['H2','FIRST_A'],
  ]) {
    await upsertCoach(rajdhani.id, coachNumber, classType);
  }
  console.log('  ✓ 12951 Mumbai Rajdhani');

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
