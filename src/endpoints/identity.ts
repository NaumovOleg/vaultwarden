import { randomBytes } from 'node:crypto';
import {
  clearFailedLogins,
  issueSession,
  rateLimit,
  recordFailedLogin,
  verifyClientHash,
} from '../auth';
import { newToken, newUuid, DEFAULT_KDF, hashPassword } from '../crypto';
import { badRequest, BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { DeviceItem, Store, UserItem } from '../store';
import { TFA_TOKEN_TTL_SECONDS } from '../auth';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function jsonValue(container: Record<string, unknown>, key: string): unknown {
  const v = container[key];
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

interface KdfConfig {
  type: number;
  iterations: number;
  memory: number | null;
  parallelism: number | null;
}

const FALLBACK_KDF: KdfConfig = {
  type: DEFAULT_KDF.kdfType,
  iterations: DEFAULT_KDF.kdfIterations,
  memory: DEFAULT_KDF.kdfMemory,
  parallelism: DEFAULT_KDF.kdfParallelism,
};

export function normalizeKdf(kdf: unknown, fallback: KdfConfig): KdfConfig {
  const k = (kdf ?? {}) as Record<string, unknown>;
  return {
    type: Number(k.kdfType ?? k.type ?? fallback.type),
    iterations: Number(k.kdfIterations ?? k.iterations ?? fallback.iterations),
    memory: k.kdfMemory !== undefined && k.kdfMemory !== null ? Number(k.kdfMemory) : null,
    parallelism:
      k.kdfParallelism !== undefined && k.kdfParallelism !== null ? Number(k.kdfParallelism) : null,
  };
}

// POST /identity/accounts/register and POST /api/accounts/register (both paths).
export async function register(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  if (process.env.SIGNUPS_ALLOWED !== 'true') {
    throw new BitwardenError(403, 'Registration is disabled.');
  }

  const body = ctx.bodyJson;
  const email = String(body.email ?? ctx.bodyForm.get('email') ?? '').trim().toLowerCase();
  if (!email.includes('@')) {
    throw badRequest('Invalid email address.');
  }

  const auth = (jsonValue(body, 'masterPasswordAuthentication') ?? {}) as Record<string, unknown>;
  const clientHash = auth.hash ?? body.masterPasswordHash ?? ctx.bodyForm.get('masterPasswordHash');
  if (typeof clientHash !== 'string' || clientHash === '') {
    throw badRequest('Master password hash is required.');
  }

  if (await ctx.store.getUserByEmail(email)) {
    throw new BitwardenError(400, 'An account with this email already exists.');
  }

  // No-email invite flow: register may arrive with orgInviteToken; validate
  // before creating the account so a bad token leaves no orphan user.
  const inviteToken = String(body.orgInviteToken ?? '').trim();
  let invitedMember: Awaited<ReturnType<typeof ctx.store.getOrgUserByToken>> | null = null;
  if (inviteToken !== '') {
    invitedMember = await ctx.store.getOrgUserByToken(inviteToken);
    if (!invitedMember || invitedMember.status !== 0 || invitedMember.userId) {
      throw badRequest('Invalid or expired invitation token.');
    }
  }

  const keys = (jsonValue(body, 'keys') ?? {}) as Record<string, unknown>;
  const salt = randomBytes(64);
  const kdf = normalizeKdf(auth.kdf, FALLBACK_KDF);
  const id = newUuid();
  const now = new Date();
  const user: UserItem = {
    pk: `USER#${id}`,
    sk: 'PROFILE',
    id,
    email,
    passwordHash: hashPassword(Buffer.from(clientHash, 'base64'), salt, 600000).toString('base64'),
    salt: salt.toString('base64'),
    passwordIterations: 600000,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    securityStamp: newUuid(),
    akey: String(body.key ?? ''),
    privateKey: typeof keys.privateKey === 'string' ? keys.privateKey : null,
    publicKey: typeof keys.publicKey === 'string' ? keys.publicKey : null,
    name: String(body.name ?? ''),
    masterPasswordHint:
      typeof body.masterPasswordHint === 'string' && body.masterPasswordHint !== '' ? body.masterPasswordHint : null,
    enabled: true,
    premium: true,
    twoFactorEnabled: false,
    totpSecret: null,
    email2faEnabled: false,
    email2faAddress: null,
    avatarColor: '#607D8B',
    masterKeyEncryptedUserKey:
      typeof body.masterKeyEncryptedUserKey === 'string' ? body.masterKeyEncryptedUserKey : null,
    masterKeyWrappedUserKey:
      typeof body.masterKeyWrappedUserKey === 'string' ? body.masterKeyWrappedUserKey : null,
    revisionDate: now.toISOString(),
    revisionDateMs: now.getTime(),
    createdAt: now.toISOString(),
  };
  await ctx.store.putUser(user);

  // Bind the account to the invitation now that the user exists.
  if (invitedMember) {
    const now = new Date().toISOString();
    await ctx.store.deleteOrgUser(invitedMember.orgId, invitedMember.id);
    await ctx.store.putOrgUser({
      ...invitedMember,
      pk: `ORGUSER#${invitedMember.orgId}#${id}`,
      id,
      userId: id,
      status: 2,
      accessToken: null,
      revisionDate: now,
    });
  }

  return json(200, {});
}

// POST /identity/accounts/prelogin, /identity/accounts/prelogin/password and
// /api/accounts/prelogin. Unknown email returns server defaults, never 404.
export async function prelogin(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const email = String(ctx.bodyJson.email ?? ctx.bodyForm.get('email') ?? '').trim().toLowerCase();
  const user = email.includes('@') ? await ctx.store.getUserByEmail(email) : null;

  const config = user
    ? {
        type: user.kdfType,
        iterations: user.kdfIterations,
        memory: user.kdfMemory,
        parallelism: user.kdfParallelism,
      }
    : FALLBACK_KDF;

  return json(200, {
    kdf: config.type,
    kdfIterations: config.iterations,
    kdfMemory: config.memory,
    kdfParallelism: config.parallelism,
    kdfSettings: {
      kdfType: config.type,
      iterations: config.iterations,
      memory: config.memory,
      parallelism: config.parallelism,
    },
    salt: null,
  });
}

// --- connect/token -----------------------------------------------------------

function paramsMap(ctx: RouteContext): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of ctx.bodyForm) m.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(ctx.bodyJson)) {
    if (typeof v === 'string' || typeof v === 'number') m.set(k.toLowerCase(), String(v));
  }
  return m;
}

function oauthError(status: number, error: string, description?: string) {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return json(status, body);
}

const INVALID_GRANT = () => oauthError(400, 'invalid_grant', 'Username or password is incorrect.');
const INVALID_GRANT_MIN = () => oauthError(400, 'invalid_grant');

function authenticatedResponse(user: UserItem, pair: { accessToken: string; refreshToken: string; accessExpiresIn: number; refreshExpiresIn: number }, twoFactorToken?: string) {
  return json(200, {
    access_token: pair.accessToken,
    expires_in: pair.accessExpiresIn,
    token_type: 'Bearer',
    refresh_token: pair.refreshToken,
    Key: user.akey,
    PrivateKey: user.privateKey,
    Kdf: user.kdfType,
    KdfIterations: user.kdfIterations,
    KdfMemory: user.kdfMemory,
    KdfParallelism: user.kdfParallelism,
    ResetMasterPassword: false,
    ForcePasswordReset: false,
    ApiKeyClientSecretHint: null,
    securityStamp: user.securityStamp,
    passwordlessLogin: false,
    TwoFactorProviders: null,
    ...(twoFactorToken ? { TwoFactorToken: twoFactorToken } : {}),
  });
}

async function upsertDevice(store: Store, user: UserItem, form: Map<string, string>, deviceId: string): Promise<void> {
  const existing = await store.getDevice(user.id, deviceId);
  const now = new Date().toISOString();
  const device: DeviceItem = {
    pk: `USER#${user.id}`,
    sk: `DEV#${deviceId}`,
    name: form.get('devicename') ?? null,
    type: Number(form.get('devicetype') ?? 0),
    pushToken: form.get('devicepushtoken') ?? null,
    creationDate: existing?.creationDate ?? now,
    lastUsed: now,
    twoFactorRemembered: existing?.twoFactorRemembered ?? false,
  };
  await store.upsertDevice(device);
}

async function passwordGrant(ctx: RouteContext, form: Map<string, string>): Promise<unknown> {
  const scope = form.get('scope') ?? '';
  if (scope && !(scope.includes('api') && scope.includes('offline_access'))) {
    return oauthError(400, 'invalid_grant', 'The scope must contain "api offline_access".');
  }
  if (form.get('auth_request')) {
    return oauthError(400, 'invalid_grant', 'Auth request not found.');
  }
  const username = form.get('username') ?? '';
  const password = form.get('password') ?? form.get('masterpasswordhash');
  if (!username || !password) return INVALID_GRANT();

  await rateLimit(ctx.store, ctx.sourceIp);

  const user = await ctx.store.getUserByEmail(username);
  if (!user || !verifyClientHash(user, password)) {
    // Same response whether the email is unknown or the password is wrong.
    await recordFailedLogin(ctx.store, ctx.sourceIp);
    return INVALID_GRANT();
  }
  if (!user.enabled) {
    return oauthError(400, 'invalid_grant', 'This user has been disabled');
  }

  const twoFactorToken = form.get('twofactortoken') ?? ctx.headers['auth-2fa'];
  if (user.twoFactorEnabled) {
    if (!twoFactorToken) {
      const tfa = newToken();
      await ctx.store.putTwoFactorToken({
        pk: `TFA#${tfa}`,
        sk: 'TOKEN',
        userId: user.id,
        deviceId: '',
        providers: [],
        expiresAt: Math.floor(Date.now() / 1000) + TFA_TOKEN_TTL_SECONDS,
      });
      return json(200, {
        error: 'invalid_grant',
        error_description: 'Two factor required.',
        TwoFactorProviders: [],
        TwoFactorProviders2: {},
        MasterPasswordPolicy: { Object: 'masterPasswordPolicy' },
        TwoFactorToken: tfa,
      });
    }
    const tfaItem = await ctx.store.getTwoFactorToken(twoFactorToken);
    if (!tfaItem || tfaItem.userId !== user.id) {
      return INVALID_GRANT_MIN();
    }
    await ctx.store.deleteTwoFactorToken(twoFactorToken);
  }

  await clearFailedLogins(ctx.store, ctx.sourceIp);

  const deviceId = form.get('deviceidentifier') ?? newUuid();
  await upsertDevice(ctx.store, user, form, deviceId);
  const pair = await issueSession(ctx.store, user, deviceId);
  return authenticatedResponse(user, pair);
}

async function refreshGrant(ctx: RouteContext, form: Map<string, string>): Promise<unknown> {
  const refreshToken = form.get('refresh_token') ?? '';
  if (!refreshToken) return INVALID_GRANT_MIN();
  const session = await ctx.store.getSession(refreshToken);
  if (!session || session.type !== 'refresh') return INVALID_GRANT_MIN();

  const user = await ctx.store.getUser(session.userId);
  // Stamp mismatch: sessions were revoked (password change/logout-all).
  if (!user || user.securityStamp !== session.stamp) {
    await ctx.store.deleteSession(refreshToken);
    return INVALID_GRANT_MIN();
  }

  // Rotate: the old pair dies together, the new pair is issued.
  if (session.pairedAccess) await ctx.store.deleteSession(session.pairedAccess);
  await ctx.store.deleteSession(refreshToken);

  await upsertDevice(ctx.store, user, form, session.deviceId);
  const pair = await issueSession(ctx.store, user, session.deviceId);
  return authenticatedResponse(user, pair);
}

// POST /identity/connect/token — password + refresh grants, form-encoded
// (some SDK clients send JSON; field names are case-insensitive).
export async function token(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const form = paramsMap(ctx);
  const grantType = form.get('grant_type') ?? '';
  if (grantType === 'password') return passwordGrant(ctx, form);
  if (grantType === 'refresh_token') return refreshGrant(ctx, form);
  return oauthError(400, 'unsupported_grant_type', 'The grant type is not supported.');
}

// POST /identity/connect/endsession — deletes the pair; never errors.
export async function endsession(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const form = paramsMap(ctx);
  const value = form.get('refresh_token') ?? form.get('access_token') ?? form.get('token') ?? '';
  if (value) {
    const session = await ctx.store.getSession(value);
    if (session) {
      if (session.type === 'refresh' && session.pairedAccess) {
        await ctx.store.deleteSession(session.pairedAccess);
      }
      if (session.type === 'access' && session.pairedRefresh) {
        await ctx.store.deleteSession(session.pairedRefresh);
      }
      await ctx.store.deleteSession(value);
    }
  }
  return json(200, {});
}