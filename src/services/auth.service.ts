import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { userRepository } from '../repositories/user.repository';
import { ConflictError, UnauthorizedError } from '../errors/AppError';

// Shape returned to the HTTP layer — password hash is never included
type UserPublic = { id: string; name: string; email: string; role: string; createdAt: Date };

function toPublic(user: { id: string; name: string; email: string; role: string; createdAt: Date }): UserPublic {
  return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt };
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

    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
    );

    return { accessToken, user: toPublic(user) };
  },
};
