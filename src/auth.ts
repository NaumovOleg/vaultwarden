import { signJwt, verifyPassword as ctVerify } from './crypto';
import { BitwardenError } from './errors';
import type { RouteContext } from './router';
import type { SessionItem, Store, UserItem } from './store';

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const RATE_TTL_SECONDS = 60;
export const MAX_FAILED_LOGINS = 10;
export const EMAIL_LOCK_MAX = 5;
export const EMAIL_LOCK_TTL_SECONDS = 600;
export const TFA_TOKEN_TTL_SECONDS = 300;

// RFC 5322-ish, deliberately loose: local part + @ + dotted domain.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SessionPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

// Issues a new access+refresh pair for a device. The caller is responsible
// for rotating (deleting) any previous pair of the same device.
export async function issueSession(store: Store, user: UserItem, deviceId: string): Promise<SessionPair> {
  const now = Math.floor(Date.now() / 1000);
  // Official Bitwarden access tokens carry email/name/premium/device claims;
  // clients build the account profile from them (empty email breaks the vault).
  // The Android app parses the JWT with kotlinx.serialization into
  // JwtTokenDataJson, which REQUIRES email_verified (Boolean) and amr
  // (List<String>) — a missing claim makes parseJwtTokenDataOrNull return
  // null and the app crashes with "Required value was null".
  const accessToken = await signJwt(
    {
      sub: user.id,
      email: user.email,
      email_verified: true,
      name: user.email,
      premium: user.premium,
      device: deviceId,
      amr: ['pwd'],
    },
    ACCESS_TTL_SECONDS,
  );
  const refreshToken = await signJwt({ sub: user.id }, REFRESH_TTL_SECONDS);
  const access: SessionItem = {
    pk: `SESS#${accessToken}`,
    sk: 'TOKEN',
    userId: user.id,
    deviceId,
    type: 'access',
    stamp: user.securityStamp,
    expiresAt: now + ACCESS_TTL_SECONDS,
    pairedAccess: null,
    pairedRefresh: refreshToken,
  };
  const refresh: SessionItem = {
    pk: `SESS#${refreshToken}`,
    sk: 'TOKEN',
    userId: user.id,
    deviceId,
    type: 'refresh',
    stamp: user.securityStamp,
    expiresAt: now + REFRESH_TTL_SECONDS,
    pairedAccess: accessToken,
    pairedRefresh: null,
  };
  await store.putSession(access);
  await store.putSession(refresh);
  return {
    accessToken,
    refreshToken,
    accessExpiresIn: ACCESS_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
  };
}

// Validates an access token: exists, type access, unexpired, user exists,
// stamp matches. A stamp mismatch kills the session (revocation). Returns the
// session or null.
export async function verifyAccessToken(store: Store, token: string): Promise<SessionItem | null> {
  const session = await store.getSession(token);
  if (!session || session.type !== 'access') return null;
  if (typeof session.expiresAt === 'number' && session.expiresAt < Math.floor(Date.now() / 1000)) return null;
  const user = await store.getUser(session.userId);
  if (!user || user.securityStamp !== session.stamp) {
    await store.deleteSession(token);
    return null;
  }
  return session;
}

// Bearer middleware: parses `Authorization: Bearer <token>` and resolves the
// session+user. Missing/invalid/revoked → null (handler answers 401).
export async function authenticate(
  store: Store,
  ctx: Pick<RouteContext, 'headers'>,
): Promise<{ user: UserItem; session: SessionItem } | null> {
  const header = ctx.headers['authorization'] ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const session = await verifyAccessToken(store, match[1]);
  if (!session) return null;
  const user = await store.getUser(session.userId);
  if (!user) return null;
  return { user, session };
}

// Constant-time verification of the client hash against the stored wrap.
export function verifyClientHash(user: UserItem, clientHash: unknown): boolean {
  if (typeof clientHash !== 'string' || clientHash === '') return false;
  return ctVerify(
    Buffer.from(clientHash, 'base64'),
    Buffer.from(user.salt, 'base64'),
    Buffer.from(user.passwordHash, 'base64'),
    user.passwordIterations,
  );
}

// Fixed-window per-key counter (IP or "email:{email}"), max failures per
// TTL window. Success clears the window.
export async function rateLimit(store: Store, key: string, max = MAX_FAILED_LOGINS, ttl = RATE_TTL_SECONDS): Promise<void> {
  const rate = await store.getRate(key);
  if (rate && rate.count >= max) {
    throw new BitwardenError(429, 'Too many login attempts. Try again later.');
  }
}

export async function recordFailedLogin(store: Store, key: string, ttl = RATE_TTL_SECONDS): Promise<void> {
  await store.incrementRate(key, ttl);
}

export async function clearFailedLogins(store: Store, key: string): Promise<void> {
  await store.clearRate(key);
}

// Fixed-window counter that increments THEN checks: for open endpoints where a
// successful call must also count against the ceiling (register, verify-email),
// unlike rateLimit which only reads the pump from recordFailedLogin.
export async function consumeRate(store: Store, key: string, max: number, ttl: number): Promise<void> {
  await store.incrementRate(key, ttl);
  const rate = await store.getRate(key);
  if (rate && rate.count > max) {
    throw new BitwardenError(429, 'Too many requests. Try again later.');
  }
}