import { prisma } from '../config/prisma';

export const stationRepository = {
  findAll() {
    return prisma.station.findMany({
      select:  { code: true, name: true, city: true },
      orderBy: { code: 'asc' },
    });
  },
};
