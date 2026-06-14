import { prisma } from '../config/prisma';

export const refreshTokenRepository = {
  create(data: { userId: string; tokenHash: string; familyId: string; expiresAt: Date }) {
    return prisma.refreshToken.create({ data });
  },

  findByHash(tokenHash: string) {
    return prisma.refreshToken.findUnique({ where: { tokenHash } });
  },

  revoke(id: string) {
    return prisma.refreshToken.update({
      where: { id },
      data:  { revokedAt: new Date() },
    });
  },

  // Revoke every still-active token in a family — used when reuse of a rotated
  // token signals theft.
  revokeFamily(familyId: string) {
    return prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
  },
};
