import * as crypto from 'node:crypto';

export const DEFAULT_KDF = {
  kdfType: 0, // PBKDF2-SHA256
  kdfIterations: 600_000,
  kdfMemory: null as number | null,
  kdfParallelism: null as number | null,
};

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function newUuid(): string {
  return crypto.randomUUID();
}

// Server-side wrap on top of the client's password hash, exactly like
// vaultwarden crypto::hash_password (PBKDF2-SHA256, 64-byte output).
export function hashPassword(secret: Buffer, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(secret, salt, iterations, 64, 'sha256');
}

export function verifyPassword(secret: Buffer, salt: Buffer, stored: Buffer, iterations: number): boolean {
  const computed = hashPassword(secret, salt, iterations);
  return computed.length === stored.length && crypto.timingSafeEqual(computed, stored);
}

export function ctEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}