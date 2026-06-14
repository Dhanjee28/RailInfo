import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { userRepository } from '../repositories/user.repository';
import { refreshTokenRepository } from '../repositories/refreshToken.repository';
import { generateOpaqueToken, hashToken } from '../utils/tokens';
import { ConflictError, UnauthorizedError } from '../errors/AppError';

// Shape returned to the HTTP layer — password hash is never included
type UserPublic = { id: string; name: string; email: string; role: string; createdAt: Date };

function toPublic(user: { id: string; name: string; email: string; role: string; createdAt: Date }): UserPublic {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
}

function signAccessToken(user: { id: string; role: Role | string }): string {
  return jwt.sign(
    { userId: user.id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );
}

// Mints a refresh token, persists only its hash, and returns the raw token for
// the client. `familyId` continues an existing chain on rotation, or starts a
// new one on a fresh login.
async function issueRefreshToken(userId: string, familyId?: string) {
  const raw       = generateOpaqueToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const family    = familyId ?? crypto.randomUUID();

  await refreshTokenRepository.create({ userId, tokenHash, familyId: family, expiresAt });
  return { raw, expiresAt };
}

export const authService = {
  async register(data: { name: string; email: string; password: string }) {
    const existing = await userRepository.findByEmail(data.email);
    if (existing) throw new ConflictError('EMAIL_TAKEN', 'This email is already registered');

    const passwordHash = await bcrypt.hash(data.password, env.BCRYPT_ROUNDS);
    const user = await userRepository.create({ name: data.name, email: data.email, passwordHash });

    return { user: toPublic(user) };
  },

  async login(data: { email: string; password: string }) {
    const user = await userRepository.findByEmail(data.email);

    // Same generic message for wrong email and wrong password — prevents
    // username enumeration: an attacker shouldn't learn which half is wrong.
    const invalid = () => new UnauthorizedError('Invalid email or password');

    if (!user) throw invalid();

    const passwordMatch = await bcrypt.compare(data.password, user.passwordHash);
    if (!passwordMatch) throw invalid();

    const accessToken = signAccessToken(user);
    const refresh     = await issueRefreshToken(user.id);

    return {
      accessToken,
      refreshToken:     refresh.raw,
      refreshExpiresAt: refresh.expiresAt,
      user:             toPublic(user),
    };
  },

  // Validates a refresh token and rotates it: the presented token is revoked and
  // a fresh one is issued in the same family. Reuse of an already-revoked token
  // is treated as theft → the whole family is revoked.
  async refresh(rawToken: string | undefined) {
    if (!rawToken) throw new UnauthorizedError('Missing refresh token');

    const stored = await refreshTokenRepository.findByHash(hashToken(rawToken));
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    if (stored.revokedAt) {
      // A revoked token being presented again = someone is replaying a stolen,
      // already-rotated token. Burn the entire family.
      await refreshTokenRepository.revokeFamily(stored.familyId);
      throw new UnauthorizedError('Refresh token reuse detected — session revoked');
    }

    await refreshTokenRepository.revoke(stored.id);

    const user = await userRepository.findById(stored.userId);
    if (!user) throw new UnauthorizedError('User no longer exists');

    const accessToken = signAccessToken(user);
    const refresh     = await issueRefreshToken(user.id, stored.familyId);

    return {
      accessToken,
      refreshToken:     refresh.raw,
      refreshExpiresAt: refresh.expiresAt,
      user:             toPublic(user),
    };
  },

  // Idempotent: revokes the presented token if it's still active. Always succeeds
  // so logout never errors even with a stale/absent cookie.
  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    const stored = await refreshTokenRepository.findByHash(hashToken(rawToken));
    if (stored && !stored.revokedAt) await refreshTokenRepository.revoke(stored.id);
  },
};
