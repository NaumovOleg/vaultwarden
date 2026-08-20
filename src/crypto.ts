import * as crypto from 'node:crypto';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export const DEFAULT_KDF = {
  kdfType: 0, // PBKDF2-SHA256
  kdfIterations: 600_000,
  kdfMemory: null as number | null,
  kdfParallelism: null as number | null,
};

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// HS256 JWT for access/refresh tokens: the 2026 clients' SDK decodes the
// access token payload (sub = userId). The server never verifies the
// signature — sessions are looked up by the raw token string in the store
// (a forged token has no session row; the secret only authenticates tokens
// to clients) — but the token must look like a real JWT.
//
// No hardcoded fallback: JWT_SECRET is mandatory. Prefer the env var (set
// locally); JWT_SECRET_REF names a SSM Parameter Store SecureString that the
// Lambda resolves on first use. If the parameter does not exist yet, the
// Lambda generates a secret and writes it (self-provisioning; rotate by
// overwriting the parameter — the running instance picks it up on the next
// cold start).
let jwtSecretPromise: Promise<string> | null = null;

async function ssmSecret(): Promise<string> {
  const client = new SSMClient({});
  const ref = process.env.JWT_SECRET_REF;
  if (!ref) throw new Error('JWT_SECRET is not set; refusing to sign tokens.');
  async function get(): Promise<string | null> {
    const res = await client.send(new GetParameterCommand({ Name: ref, WithDecryption: true }));
    return res.Parameter?.Value ?? null;
  }
  const existing = await get();
  if (existing) return existing;
  try {
    await client.send(new PutParameterCommand({
      Name: ref,
      Type: 'SecureString',
      Value: newToken(),
      Overwrite: false,
    }));
  } catch {
    // ParameterNotFound race (two cold starts): whoever wrote it first wins.
  }
  const value = await get();
  if (!value) throw new Error(`JWT_SECRET_REF ${ref} could not be provisioned or read.`);
  return value;
}

export async function jwtSecret(): Promise<string> {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!jwtSecretPromise) jwtSecretPromise = ssmSecret();
  return jwtSecretPromise;
}

export async function signJwt(claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ ...claims, jti: newToken(), iat: now, nbf: now, exp: now + ttlSeconds }),
  ).toString('base64url');
  const secret = await jwtSecret();
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
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

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(b32: string): Buffer {
  const clean = b32.replace(/=+$/, '').replace(/[\s-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 32-byte secret → 52-char base32 (no padding), like vaultwarden's generator.
export function totpSecret(): string {
  return base32Encode(crypto.randomBytes(32));
}

function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const mac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secretB32: string, whenMs = Date.now(), digits = 6, period = 30): string {
  const counter = BigInt(Math.floor(whenMs / 1000 / period));
  return hotp(base32Decode(secretB32), counter, digits);
}

// Accepts codes within ±window steps of the current time (default ±1).
export function totpVerify(secretB32: string, code: string, whenMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(whenMs / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(base32Decode(secretB32), BigInt(counter + i), 6);
    if (ctEq(candidate, code)) return true;
  }
  return false;
}

// Recovery codes: 'XXXXX-XXXXX', stored as SHA-256 hex.
export function recoveryCode(): string {
  return base32Encode(crypto.randomBytes(5)).slice(0, 5) + '-' + base32Encode(crypto.randomBytes(5)).slice(0, 5);
}

export function recoveryHash(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}