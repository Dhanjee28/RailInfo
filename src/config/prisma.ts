import { PrismaClient } from '@prisma/client';

// Single PrismaClient instance for the whole process.
// Node.js caches modules, so this file is evaluated once and the same client
// is returned wherever it is imported.
export const prisma = new PrismaClient();
