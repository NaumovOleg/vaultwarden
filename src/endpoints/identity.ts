import { randomBytes, randomInt } from 'node:crypto';
import {
  clearFailedLogins,
  issueSession,
  rateLimit,
  recordFailedLogin,
  verifyClientHash,
} from '../auth';
import { newToken, newUuid, DEFAULT_KDF, hashPassword } from '../crypto';
import { twoFactorChallenge, verifyTwoFactorCode } from './two-factor';
import { badRequest, BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { VerifyTokenItem, DeviceItem, Store, UserItem } from '../store';
import { TFA_TOKEN_TTL_SECONDS, EMAIL_LOCK_MAX, EMAIL_LOCK_TTL_SECONDS } from '../auth';

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
// POST /identity/accounts/register/send-verification-email — web vault shows
// a "verify your email" step after every registration and fires this. With
// SES configured the code is mailed as a finish-signup link (the web vault
// finishes registration itself); without a mailer we return the opaque token
// directly so the client can breeze through (old no-mail path).
const VERIFY_TOKEN_TTL_SECONDS = 30 * 60;

function originUrl(ctx: RouteContext): string {
  const h = ctx.headers['host'] ?? ctx.headers['x-forwarded-host'] ?? '';
  return h ? `https://${h}` : 'https://vaultwarden.free-bert.online';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mailerAvailable(ctx: RouteContext): boolean {
  return process.env.SES_SOURCE !== undefined && process.env.SES_SOURCE !== '';
}

export async function sendVerificationEmail(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  if (process.env.SIGNUPS_ALLOWED !== 'true') {
    throw new BitwardenError(403, 'Registration is disabled.');
  }

  const body = ctx.bodyJson as Record<string, unknown>;
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) {
    throw badRequest('Invalid email address.');
  }

  const existing = await ctx.store.getUserByEmail(email);
  if (existing && existing.emailVerified !== false) {
    throw new BitwardenError(400, 'An account with this email already exists.');
  }

  const token = newToken();
  const item: VerifyTokenItem = {
    pk: `VERIFY#${token}`,
    sk: 'TOKEN',
    email,
    name: String(body.name ?? '').trim() || null,
    expiresAt: Math.floor(Date.now() / 1000) + VERIFY_TOKEN_TTL_SECONDS,
  };

  if (existing) {
    // Unverified account: resend a verify link (the register call that
    // created it also accepted a token; this covers clients that skipped it).
    item.userId = existing.id;
    await ctx.store.putVerifyToken(item);
    if (mailerAvailable(ctx)) {
      await ctx.mailer.send(
        email,
        'Verify your email',
        `Confirm your email: ${originUrl(ctx)}/verify-email.html?userId=${existing.id}&token=${token}`,
      );
      return json(200, {});
    }
    return json(200, '');
  }

  await ctx.store.putVerifyToken(item);
  // Client branches on the body being a string: string → finish-signup with
  // the token, anything else → "check your email" screen.
  if (mailerAvailable(ctx)) {
    await ctx.mailer.send(
      email,
      'Finish creating your account',
      `Finish creating your account: ${originUrl(ctx)}/#/finish-signup?email=${encodeURIComponent(email)}&emailVerificationToken=${token}`,
    );
    return json(200, {});
  }
  return json(200, token);
}

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
  // 2026 web vault serializes as { salt, kdf, masterPasswordAuthenticationHash };
  // older clients send { hash, kdf }.
  const clientHash =
    auth.hash ??
    auth.masterPasswordAuthenticationHash ??
    body.masterPasswordHash ??
    ctx.bodyForm.get('masterPasswordHash');
  if (typeof clientHash !== 'string' || clientHash === '') {
    throw badRequest('Master password hash is required.');
  }

  // register/finish path (new web vault flow): the verification token from
  // send-verification-email is mandatory, single-use, and carries the name
  // when the finish request doesn't (vaultwarden register_v2 behavior).
  const verifyToken = String(body.emailVerificationToken ?? '').trim();
  let verifiedName: string | null = null;
  let verifiedByToken = false;
  if (verifyToken !== '') {
    const v = await ctx.store.getVerifyToken(verifyToken);
    if (!v || v.expiresAt < Math.floor(Date.now() / 1000)) {
      throw badRequest('Verification token is invalid or has expired.');
    }
    if (v.email !== email) {
      throw badRequest('Email verification token does not match email.');
    }
    verifiedName = v.name;
    verifiedByToken = true;
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

  // Emergency access invite binder (MISC-05): emergencyAccessToken +
  // emergencyAccessId bind straight to the EA item once the account exists.
  const eaToken = String(body.emergencyAccessToken ?? '').trim();
  const eaId = String(body.emergencyAccessId ?? '').trim();
  let invitedAccess: Awaited<ReturnType<typeof ctx.store.getEmergencyAccessByToken>> | null = null;
  if (eaToken !== '' || eaId !== '') {
    invitedAccess = await ctx.store.getEmergencyAccessByToken(eaToken);
    if (!invitedAccess || invitedAccess.itemId !== eaId || invitedAccess.status !== 0) {
      throw badRequest('Invalid or expired emergency access invitation.');
    }
    if (invitedAccess.email !== email) {
      throw badRequest('Invitation is for a different email address.');
    }
  }

  const keys = (jsonValue(body, 'keys') ?? {}) as Record<string, unknown>;
  // 2026 web vault sends the account key pair as userAsymmetricKeys
  // { publicKey, encryptedPrivateKey } instead of the legacy `keys`.
  const userKeys = (jsonValue(body, 'userAsymmetricKeys') ?? {}) as Record<string, unknown>;
  // New clients derive the hash against a client-generated salt and send it
  // along (old clients leave it to us, some send it at the JSON root).
  const clientSaltRaw = typeof auth.salt === 'string' && auth.salt !== ''
    ? auth.salt
    : typeof body.salt === 'string' && body.salt !== ''
      ? body.salt
      : null;
  const clientSalt = clientSaltRaw ? Buffer.from(clientSaltRaw, 'base64') : null;
  const salt = clientSalt ?? randomBytes(64);
  const kdf = normalizeKdf(auth.kdf, FALLBACK_KDF);
  const unlock = (jsonValue(body, 'masterPasswordUnlock') ?? {}) as Record<string, unknown>;
  const unlockWrappedKey =
    typeof unlock.masterKeyWrappedUserKey === 'string' ? unlock.masterKeyWrappedUserKey : null;
  const id = newUuid();
  const now = new Date();
  // Email verification: a consumed signup token, or a server-issued invite
  // (org/emergency-access) whose address was already vetted, marks the
  // account verified. With SES configured, clients that skip verification can
  // register but cannot log in until they verify (send-verification-email
  // resends the link). Without a mailer there is no way to verify, so
  // accounts are born verified (old dev/self-serve behavior).
  const emailVerified =
    verifiedByToken || inviteToken !== '' || eaToken !== '' || !mailerAvailable(ctx);
  const user: UserItem = {
    pk: `USER#${id}`,
    sk: 'PROFILE',
    id,
    email,
    passwordHash: hashPassword(Buffer.from(clientHash, 'base64'), salt, kdf.iterations).toString('base64'),
    // Keep the client's salt verbatim: re-encoding it (toString('base64') of
    // the decoded buffer) can drop trailing bits and return a DIFFERENT string
    // than the client hashes against, breaking master-key derivation on login.
    salt: clientSaltRaw ?? salt.toString('base64'),
    passwordIterations: kdf.iterations,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    securityStamp: newUuid(),
    // New clients skip the legacy `key` field; the wrapped user key (which
    // they do send) doubles as the account key, like vaultwarden.
    akey: String(body.key ?? '') || unlockWrappedKey || '',
    privateKey:
      typeof keys.privateKey === 'string'
        ? keys.privateKey
        : typeof userKeys.encryptedPrivateKey === 'string'
          ? userKeys.encryptedPrivateKey
          : null,
    publicKey:
      typeof keys.publicKey === 'string'
        ? keys.publicKey
        : typeof userKeys.publicKey === 'string'
          ? userKeys.publicKey
          : null,
    name: verifiedName ?? String(body.name ?? ''),
    masterPasswordHint:
      typeof body.masterPasswordHint === 'string' && body.masterPasswordHint !== '' ? body.masterPasswordHint : null,
    enabled: true,
    premium: true,
    emailVerified,
    twoFactorEnabled: false,
    totpSecret: null,
    totpPendingSecret: null,
    email2faEnabled: false,
    email2faAddress: null,
    domainsOverride: null,
    avatarColor: '#607D8B',
    // New clients send the unlock envelope inside masterPasswordUnlock.
    masterKeyEncryptedUserKey:
      typeof unlock.masterKeyEncryptedUserKey === 'string'
        ? unlock.masterKeyEncryptedUserKey
        : typeof body.masterKeyEncryptedUserKey === 'string'
          ? body.masterKeyEncryptedUserKey
          : unlockWrappedKey,
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

  // Bind the emergency access invite: status 0 → 1, grantee keys land here.
  if (invitedAccess) {
    await ctx.store.putEmergencyAccess({
      ...invitedAccess,
      granteeId: id,
      name: typeof body.name === 'string' && body.name !== '' ? body.name : invitedAccess.name,
      encryptedPrivateKey:
        typeof keys.privateKey === 'string'
          ? keys.privateKey
          : typeof userKeys.encryptedPrivateKey === 'string'
            ? userKeys.encryptedPrivateKey
            : null,
      publicKey:
        typeof keys.publicKey === 'string'
          ? keys.publicKey
          : typeof userKeys.publicKey === 'string'
            ? userKeys.publicKey
            : null,
      token: null,
      GSI1PK: `EMERGGRANTEE#${id}`,
      status: 1,
      revisionDate: new Date().toISOString(),
    });
  }

  // Burn the single-use verification token only once the account exists.
  if (verifyToken !== '') {
    await ctx.store.deleteVerifyToken(verifyToken);
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
    // The 2026 clients derive masterPasswordAuthenticationHash from the salt
    // returned here. Unknown email → null (don't leak account existence).
    salt: user ? user.salt : null,
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

// Client master-password hash from a password-grant request, wherever the
// client put it: `password`/`MasterPasswordHash` form fields (classic), or
// nested `masterPasswordAuthentication: {masterPasswordAuthenticationHash}`
// as a JSON body or JSON string form field (2026 SDK clients).
function extractClientHash(ctx: RouteContext, form: Map<string, string>): string {
  const direct = form.get('password') ?? form.get('masterpasswordhash') ?? '';
  if (direct) return direct;

  let auth = (jsonValue(ctx.bodyJson, 'masterPasswordAuthentication') ?? {}) as Record<string, unknown>;
  const authStr = form.get('masterpasswordauthentication');
  if (typeof authStr === 'string' && authStr !== '') {
    try {
      const parsed = JSON.parse(authStr);
      if (parsed && typeof parsed === 'object') auth = parsed as Record<string, unknown>;
    } catch {
      // not JSON — fall through to the JSON-body value
    }
  }
  const fromAuth = auth.masterPasswordAuthenticationHash ?? auth.hash;
  return typeof fromAuth === 'string' ? fromAuth : '';
}

function oauthError(status: number, error: string, description?: string) {
  const body: Record<string, string> = { error };
  if (description) body.error_description = description;
  return json(status, body);
}

const INVALID_GRANT = () => oauthError(400, 'invalid_grant', 'Username or password is incorrect.');
const INVALID_GRANT_MIN = () => oauthError(400, 'invalid_grant');

export function authenticatedResponse(user: UserItem, pair: { accessToken: string; refreshToken: string; accessExpiresIn: number; refreshExpiresIn: number }, twoFactorToken?: string) {
  // MasterPasswordUnlock mirrors vaultwarden: the wrapped key doubles as the
  // account key, the Salt slot is deprecated/unused by the clients, and both
  // key slots are always non-null strings (the Kotlin
  // MasterPasswordUnlockDataJson requires masterKeyWrappedUserKey).
  const masterPasswordUnlock = {
    Kdf: {
      KdfType: user.kdfType,
      Iterations: user.kdfIterations,
      Memory: user.kdfMemory,
      Parallelism: user.kdfParallelism,
    },
    MasterKeyEncryptedUserKey: user.masterKeyEncryptedUserKey ?? user.akey,
    MasterKeyWrappedUserKey: user.masterKeyWrappedUserKey ?? user.masterKeyEncryptedUserKey ?? user.akey,
    Salt: user.email,
  };
  const accountKeys =
    user.privateKey && user.publicKey
      ? {
          publicKeyEncryptionKeyPair: {
            wrappedPrivateKey: user.privateKey,
            publicKey: user.publicKey,
            Object: 'publicKeyEncryptionKeyPair',
          },
          Object: 'privateKeys',
        }
      : null;

  return json(200, {
    access_token: pair.accessToken,
    expires_in: pair.accessExpiresIn,
    token_type: 'Bearer',
    // scope is a required field in the SDK's LoginSuccessApiResponse; without it
    // strict WASM clients fail the token parse (pitfall 1.3).
    scope: 'api offline_access',
    refresh_token: pair.refreshToken,
    Key: user.akey,
    PrivateKey: user.privateKey,
    Kdf: user.kdfType,
    KdfIterations: user.kdfIterations,
    KdfMemory: user.kdfMemory,
    KdfParallelism: user.kdfParallelism,
    ResetMasterPassword: false,
    ForcePasswordReset: false,
    MasterPasswordPolicy: null,
    AccountKeys: accountKeys,
    UserDecryptionOptions: {
      HasMasterPassword: true,
      MasterPasswordUnlock: masterPasswordUnlock,
      Object: 'userDecryptionOptions',
    },
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
  // Classic clients put the client hash in `password` (or `MasterPasswordHash`).
  // SDK clients (2026) send it nested as masterPasswordAuthentication
  // (JSON body or JSON string field), like in register.
  const clientHash = extractClientHash(ctx, form);
  if (!username || !clientHash) return INVALID_GRANT();

  await rateLimit(ctx.store, ctx.sourceIp);
  // Per-account lock: repeated failures against a known email lock the
  // account briefly regardless of the source IP.
  if (username) await rateLimit(ctx.store, `email:${username}`, EMAIL_LOCK_MAX, EMAIL_LOCK_TTL_SECONDS);

  const user = await ctx.store.getUserByEmail(username);
  if (!user || !verifyClientHash(user, clientHash)) {
    // Same response whether the email is unknown or the password is wrong.
    await recordFailedLogin(ctx.store, ctx.sourceIp);
    if (username) await recordFailedLogin(ctx.store, `email:${username}`, EMAIL_LOCK_TTL_SECONDS);
    return INVALID_GRANT();
  }
  if (user.emailVerified === false) {
    return oauthError(400, 'invalid_grant', 'Email not verified.');
  }
  if (!user.enabled) {
    return oauthError(400, 'invalid_grant', 'This user has been disabled');
  }

  const twoFactorToken = form.get('twofactortoken') ?? ctx.headers['auth-2fa-token'];
  const deviceId = form.get('deviceidentifier') ?? newUuid();
  if (user.twoFactorEnabled) {
    const device = await ctx.store.getDevice(user.id, deviceId);

    if (!twoFactorToken) {
      // Remembered device: skip the challenge entirely (device flag from a
      // previous successful 2FA login with twofactorremember=1).
      if (device?.twoFactorRemembered) {
        const now = new Date().toISOString();
        await ctx.store.upsertDevice({
          pk: `USER#${user.id}`,
          sk: `DEV#${deviceId}`,
          name: form.get('devicename') ?? device.name ?? null,
          type: Number(form.get('devicetype') ?? device.type ?? 0),
          pushToken: form.get('devicepushtoken') ?? device.pushToken ?? null,
          creationDate: device.creationDate ?? now,
          lastUsed: now,
          twoFactorRemembered: true,
        });
      } else {
        const tfa = newToken();
        await ctx.store.putTwoFactorToken({
          pk: `TFA#${tfa}`,
          sk: 'TOKEN',
          userId: user.id,
          deviceId,
          providers: [],
          expiresAt: Math.floor(Date.now() / 1000) + TFA_TOKEN_TTL_SECONDS,
        });
        return json(200, twoFactorChallenge(user, tfa));
      }
    } else {
      const tfaItem = await ctx.store.getTwoFactorToken(twoFactorToken);
      if (!tfaItem || tfaItem.userId !== user.id) {
        return INVALID_GRANT_MIN();
      }
      await ctx.store.deleteTwoFactorToken(twoFactorToken);

      const code = form.get('twofactorcode') ?? ctx.headers['auth-2fa'] ?? '';
      const provider = Number(form.get('twofactorprovider') ?? 0);
      if (!code || !(await verifyTwoFactorCode(user, provider, code, ctx))) {
        return INVALID_GRANT_MIN();
      }

      const remember = form.get('twofactorremember') === '1' || ctx.headers['auth-2fa-remember'] === '1';
      if (remember && deviceId) {
        const now = new Date().toISOString();
        await ctx.store.upsertDevice({
          pk: `USER#${user.id}`,
          sk: `DEV#${deviceId}`,
          name: form.get('devicename') ?? device?.name ?? null,
          type: Number(form.get('devicetype') ?? device?.type ?? 0),
          pushToken: form.get('devicepushtoken') ?? device?.pushToken ?? null,
          creationDate: device?.creationDate ?? now,
          lastUsed: now,
          twoFactorRemembered: true,
        });
      }
    }
  }

  await clearFailedLogins(ctx.store, ctx.sourceIp);
  if (username) await clearFailedLogins(ctx.store, `email:${username}`);

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
// POST /identity/accounts/recover — email a one-time 8-digit recovery code
// (15 min TTL). Always 200 for unknown emails (anti-enumeration); a fresh
// code whitelists a new one at most once per minute.
export async function recoverPassword(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return sendRecoveryCode(ctx, false);
}

// POST /identity/accounts/recover/two-factor — same code, used to bypass the
// 2FA challenge at login (accepted by verifyTwoFactorCode). Only emailed to
// accounts that actually have 2FA enabled; others get a silent 200.
export async function recoverTwoFactor(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return sendRecoveryCode(ctx, true);
}

const RECOVER_CODE_TTL_SECONDS = 900;
const RECOVER_CODE_MIN_INTERVAL_SECONDS = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendRecoveryCode(ctx: RouteContext, twoFactorOnly: boolean): Promise<unknown> {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const email = (jsonValue(body, 'email') ?? '').toString().trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(200, {});

  const user = await ctx.store.getUserByEmail(email);
  if (!user || (twoFactorOnly && !user.twoFactorEnabled)) return json(200, {});

  const existing = await ctx.store.getRecoverCode(user.id);
  if (existing && existing.expiresAt > Math.floor(Date.now() / 1000) - RECOVER_CODE_MIN_INTERVAL_SECONDS) {
    return json(429, { error: 'Recovery email was sent recently; wait a minute and retry.' });
  }

  const code = String(randomInt(0, 1_0000_0000)).padStart(8, '0');
  const expiresAt = Math.floor(Date.now() / 1000) + RECOVER_CODE_TTL_SECONDS;
  await ctx.store.putRecoverCode(user.id, code, expiresAt);
  try {
    await ctx.mailer.send(
      user.email,
      'Vaultwarden recovery code',
      `Your vaultwarden recovery code is ${code}.\nIt expires in 15 minutes. If you did not request it, you can ignore this email.`,
    );
  } catch (err) {
    console.error('recover: SES send failed', err);
    return json(500, { error: 'Failed to send the recovery email.' });
  }
  return json(200, {});
}
