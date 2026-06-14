import crypto from 'crypto';

// Refresh tokens are opaque, high-entropy random strings (not JWTs): there's
// nothing to verify cryptographically, we just look them up. 32 bytes = 256 bits
// of entropy → guessing one is infeasible.
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

// We store only the hash, so a DB leak doesn't expose usable tokens. SHA-256
// (fast) is correct here — unlike passwords, the input is already high-entropy,
// so bcrypt's deliberate slowness buys nothing.
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
