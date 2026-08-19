import type { RouteContext } from '../router';
import type { UserItem } from '../store';
import { cipherJson } from './ciphers';
import { folderJson } from './folders';
import { sendJson } from './sends';
import { orgJson } from './organizations';
import { collectionJson } from './collections';
import { newUuid, newToken, hashPassword } from '../crypto';
import { verifyClientHash } from '../auth';
import { BitwardenError } from '../errors';
import { jsonValue, normalizeKdf } from './identity';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// POST /api/accounts/recover/reset — full account reset guarded by the emailed
// recovery code: new master password + new key pair, 2FA off, every device
// logged out, and the vault wiped (its data was encrypted with the old master
// key and is unrecoverable by design).
export async function recoverReset(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const email = (jsonValue(body, 'email') ?? '').toString().trim().toLowerCase();
  // jsonValue JSON-parses numeric-looking strings, so '37982902' would become
  // a number; coerce back to string before comparing.
  const code = String(jsonValue(body, 'code') ?? '');
  if (code === '') throw new BitwardenError(400, 'Recovery code is required.');
  const user = email ? await ctx.store.getUserByEmail(email) : null;
  const recover = user ? await ctx.store.getRecoverCode(user.id) : null;
  if (!user || !recover || recover.code !== code) throw new BitwardenError(400, 'Invalid recovery code.');

  const clientHash = jsonValue(body, 'newMasterPasswordHash');
  if (typeof clientHash !== 'string' || clientHash === '') throw new BitwardenError(400, 'Invalid password.');
  const keys = (jsonValue(body, 'keys') ?? {}) as Record<string, unknown>;
  const kdf = normalizeKdf(jsonValue(body, 'kdf'), {
    type: user.kdfType,
    iterations: user.kdfIterations,
    memory: user.kdfMemory,
    parallelism: user.kdfParallelism,
  });

  await ctx.store.deleteRecoverCode(user.id);
  await ctx.store.deleteEmail2faCode(user.id);
  for (const h of await ctx.store.listRecoveryHashes(user.id)) {
    await ctx.store.deleteRecoveryHash(user.id, h);
  }
  await ctx.store.clearRememberedDevices(user.id);
  for (const cipher of await ctx.store.listCiphers(user.id)) {
    await ctx.store.deleteCipher(user.id, cipher.id);
  }
  for (const folder of await ctx.store.listFolders(user.id)) {
    await ctx.store.deleteFolder(user.id, folder.id);
  }
  for (const send of await ctx.store.listSends(user.id)) {
    await ctx.store.deleteSend(user.id, send.id);
  }

  const updated: UserItem = {
    ...user,
    passwordHash: hashPassword(Buffer.from(clientHash, 'base64'), Buffer.from(user.salt, 'base64'), kdf.iterations).toString('base64'),
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    akey: typeof jsonValue(body, 'key') === 'string' ? (jsonValue(body, 'key') as string) : '',
    privateKey: typeof keys.privateKey === 'string' ? keys.privateKey : null,
    publicKey: typeof keys.publicKey === 'string' ? keys.publicKey : null,
    twoFactorEnabled: false,
    totpSecret: null,
    totpPendingSecret: null,
    email2faEnabled: false,
    email2faAddress: null,
    securityStamp: newUuid(),
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return { statusCode: 200, headers: JSON_HEADERS, body: '{}' };
}

// POST /api/accounts/email — change the account email. Requires the current
// master password; the new address is confirmed by emailing it a link before
// anything changes. Requests to an address that's already taken are rejected
// upfront (same rule as registration).
export async function changeEmail(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  requirePassword(body, user);

  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new BitwardenError(400, 'Invalid email address.');
  }
  if (email === user.email) {
    throw new BitwardenError(400, 'The new email is the same as the current one.');
  }
  if (await ctx.store.getUserByEmail(email)) {
    throw new BitwardenError(400, 'An account with this email already exists.');
  }

  const token = newToken();
  await ctx.store.putVerifyToken({
    pk: `VERIFY#${token}`,
    sk: 'TOKEN',
    email,
    name: null,
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
    userId: user.id,
    pendingEmail: email,
  });
  if (process.env.SES_SOURCE !== undefined && process.env.SES_SOURCE !== '') {
    await ctx.mailer.send(
      email,
      'Confirm your new email',
      `Confirm your new email: ${originUrl(ctx)}/verify-email.html?userId=${encodeURIComponent(user.id)}&token=${token}`,
    );
    return { statusCode: 200, headers: JSON_HEADERS, body: '{}' };
  }
  // No mailer configured: apply the change immediately (dev/self-served flow).
  const updated: UserItem = { ...user, email, emailVerified: true, revisionDate: new Date().toISOString(), revisionDateMs: Date.now() };
  await ctx.store.putUser(updated);
  await ctx.store.deleteVerifyToken(token);
  return { statusCode: 200, headers: JSON_HEADERS, body: '{}' };
}

// POST /api/accounts/verify-email — public confirmation endpoint hit from the
// emailed link. Applies a pending email change, or simply marks the account
// verified for a resend flow. Single-use token.
export async function verifyEmail(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = (ctx.bodyJson ?? {}) as Record<string, unknown>;
  const token = String(jsonValue(body, 'token') ?? '').trim();
  const userId = String(jsonValue(body, 'userId') ?? '').trim();
  if (!token || !userId) throw new BitwardenError(400, 'Invalid verification token.');

  const v = await ctx.store.getVerifyToken(token);
  // Two token flavors: change-email tokens carry userId; signup tokens are
  // minted before the account exists, so the user is matched by email.
  const owned =
    v && (v.userId === userId || (!v.userId && v.email.toLowerCase() === (await ctx.store.getUserByUserId(userId))?.email?.toLowerCase()));
  if (!v || v.expiresAt < Math.floor(Date.now() / 1000) || !owned) {
    throw new BitwardenError(400, 'Invalid verification token.');
  }
  const user = await ctx.store.getUserByUserId(userId);
  if (!user) throw new BitwardenError(400, 'Invalid verification token.');

  const updated: UserItem = { ...user, emailVerified: true };
  if (v.pendingEmail && v.pendingEmail.toLowerCase() !== user.email) {
    if (await ctx.store.getUserByEmail(v.pendingEmail)) {
      throw new BitwardenError(400, 'An account with this email already exists.');
    }
    updated.email = v.pendingEmail;
    updated.revisionDate = new Date().toISOString();
    updated.revisionDateMs = Date.now();
  }
  await ctx.store.putUser(updated);
  await ctx.store.deleteVerifyToken(token);
  return jsonResponse({});
}

function originUrl(ctx: RouteContext): string {
  // DEFAULT_DOMAIN is the canonical public host; the Host header is rewritten
  // by CloudFront to the API Gateway origin, so it must never win when set.
  const canonical = process.env.DEFAULT_DOMAIN ?? '';
  const h = ctx.headers['host'] ?? ctx.headers['x-forwarded-host'] ?? '';
  return `https://${canonical || h || 'vaultwarden.free-bert.online'}`;
}

function jsonResponse(body: unknown) {
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

async function userOrgsJson(ctx: RouteContext) {
  const memberships = await ctx.store.listOrganizationsForUser(ctx.user!.id);
  const out: Record<string, unknown>[] = [];
  for (const m of memberships) {
    const org = await ctx.store.getOrganization(m.orgId);
    if (org) out.push(orgJson(org, m));
  }
  return out;
}

async function userPoliciesJson(ctx: RouteContext): Promise<Record<string, unknown>[]> {
  const memberships = await ctx.store.listOrganizationsForUser(ctx.user!.id);
  const out: Record<string, unknown>[] = [];
  for (const m of memberships) {
    if (m.status < 2) continue;
    for (const p of await ctx.store.listPolicies(m.orgId)) {
      out.push({
        object: 'policy',
        id: p.id,
        organizationId: p.organizationId,
        type: p.type,
        enabled: p.enabled,
        data: p.data,
      });
    }
  }
  return out;
}

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// Shared profile serializer — used by GET /api/accounts/profile and /api/sync.
function profileJson(user: UserItem, orgs: Record<string, unknown>[] = []) {
  const keyPair =
    user.privateKey === null && user.publicKey === null
      ? null
      : {
          // Sync profile keys are parsed by PrivateKeysResponseModel, which
          // requires "wrappedPrivateKey" — anything else throws inside
          // syncProfile() and silently aborts the rest of the sync
          // (orgs/policies/key-connector state never initialize).
          wrappedPrivateKey: user.privateKey,
          publicKey: user.publicKey,
          // Vaultwarden always sends these two; the app's AccountKeysJson
          // has signedPublicKey as a plain nullable field, and mirroring the
          // reference shapes keeps every client parser happy.
          signedPublicKey: null,
          object: 'publicKeyEncryptionKeyPair',
        };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: true,
    premium: user.premium,
    premiumFromOrganization: false,
    culture: 'en-US',
    twoFactorEnabled: user.twoFactorEnabled,
    key: user.akey,
    privateKey: user.privateKey,
    securityStamp: user.securityStamp,
    organizations: orgs,
    providers: [],
    providerOrganizations: [],
    forcePasswordReset: false,
    avatarColor: user.avatarColor,
    usesKeyConnector: false,
    creationDate: user.createdAt,
    _status: 1,
    // The app models this with a required publicKeyEncryptionKeyPair; send
    // null (like vaultwarden) instead of an object with a null key pair,
    // which fails the Kotlin AccountKeysJson parse for accounts without keys.
    accountKeys:
      user.privateKey === null && user.publicKey === null
        ? null
        : {
            publicKeyEncryptionKeyPair: keyPair,
            securityState: null,
            signatureKeyPair: null,
            object: 'privateKeys',
          },
    object: 'profile',
    userDecryptionOptions: userDecryptionJson(user),
  };
}

export { profileJson };

function domainsJson() {
  return { equivalentDomains: [], globalEquivalentDomains: [], object: 'domains' };
}

// Shape matches the app's MasterPasswordUnlockDataJson/KdfJson: the inner kdf
// keys are `iterations`/`memory`/`parallelism` (NOT `kdfIterations`/...), and
// the wrapped key doubles as the encrypted key, like vaultwarden. Both key
// slots must be non-null strings: the Kotlin MasterPasswordUnlockDataJson has
// `masterKeyWrappedUserKey: String` (required, non-nullable) and a null value
// there fails the sync parse with MissingFieldException.
function userDecryptionJson(user: UserItem) {
  const encryptedKey = user.masterKeyEncryptedUserKey ?? user.akey;
  const wrappedKey = user.masterKeyWrappedUserKey ?? encryptedKey;
  const masterPasswordUnlock =
    user.masterKeyEncryptedUserKey || user.masterKeyWrappedUserKey
      ? {
          kdf: {
            kdfType: user.kdfType,
            iterations: user.kdfIterations,
            memory: user.kdfMemory,
            parallelism: user.kdfParallelism,
          },
          masterKeyEncryptedUserKey: encryptedKey,
          masterKeyWrappedUserKey: wrappedKey,
          salt: user.email,
        }
      : null;
  return {
    object: 'userDecryptionOptions',
    hasMasterPassword: masterPasswordUnlock !== null,
    masterPasswordUnlock,
    keyConnectorOption: null,
    trustedDeviceOption: null,
  };
}

// GET /api/accounts/profile
export async function profile(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return json(200, profileJson(ctx.user!, await userOrgsJson(ctx)));
}

// GET /api/accounts/revision-date — ms epoch (pitfall 2.2)
export async function revisionDate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return json(200, { revisionDate: ctx.user!.revisionDateMs });
}

// POST /api/accounts/keys — store keys verbatim (pitfall 2.4: explicit keys).
export async function keys(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson;
  const updated: UserItem = {
    ...user,
    privateKey: typeof body.privateKey === 'string' ? body.privateKey : user.privateKey,
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : user.publicKey,
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return json(200, {
    publicKey: updated.publicKey,
    encryptedPrivateKey: updated.privateKey,
    object: 'keys',
  });
}

// GET /api/sync — the bundle. `excludeDomains=true` → domains null;
// `partial=true` → profile + folders only (mobile initial sync).
export async function sync(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const excludeDomains = ctx.query['excludeDomains'] === 'true';
  const partial = ctx.query['partial'] === 'true';

  const folders = await ctx.store.listFolders(user.id);
  const foldersJson = folders.map(folderJson);
  const orgsJson = await userOrgsJson(ctx);

  const bundle: Record<string, unknown> = {
    profile: profileJson(user, orgsJson),
    folders: foldersJson,
    object: 'sync',
  };

  if (partial) return json(200, bundle);

  const ciphers = await ctx.store.listCiphersForUser(user.id);
  const sends = await ctx.store.listSends(user.id);
  const collections = await ctx.store.listCollectionsForUser(user.id);
  return json(200, {
    ...bundle,
    collections: collections.map((c) => collectionJson(c)),
    policies: await userPoliciesJson(ctx),
    ciphers: await Promise.all(ciphers.map((c) => cipherJson(c, 'cipherDetails', ctx.objects))),
    domains: excludeDomains ? null : domainsJson(),
    sends: sends.map(sendJson),
    organizations: orgsJson,
    providers: [],
    providerOrganizations: [],
    // Top-level key is `userDecryption` (not `userDecryptionOptions`): the Android
    // app reads syncResponse.userDecryption.masterPasswordUnlock to decide
    // hasMasterPassword. Missing/null → it forces a logout (VaultUnlockViewModel
    // InvalidState). Vaultwarden/identity.rs mirror the same key.
    userDecryption: userDecryptionJson(user),
  });
}

const JSON_ACCOUNTS_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function jwtJson(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_ACCOUNTS_HEADERS, body: JSON.stringify(body) };
}

function requirePassword(body: Record<string, unknown>, user: UserItem): void {
  const hash = jsonValue(body, 'masterPasswordHash');
  if (!verifyClientHash(user, hash)) {
    throw new BitwardenError(400, 'Invalid password.');
  }
}

// POST /api/accounts/password — verify old, store new hash (same salt wrap),
// akey, hint, kdf, keys; new securityStamp revokes all sessions (matches
// vaultwarden set_password + reset_security_stamp).
export async function changePassword(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  requirePassword(body, user);

  const newHash = jsonValue(body, 'newMasterPasswordHash');
  if (typeof newHash !== 'string' || newHash === '') {
    throw new BitwardenError(400, 'Invalid password.');
  }
  const keys = (jsonValue(body, 'keys') ?? {}) as Record<string, unknown>;
  const kdf = normalizeKdf(jsonValue(body, 'kdf'), {
    type: user.kdfType,
    iterations: user.kdfIterations,
    memory: user.kdfMemory,
    parallelism: user.kdfParallelism,
  });
  const hint = jsonValue(body, 'masterPasswordHint');
  await ctx.store.clearRememberedDevices(user.id);
  const updated: UserItem = {
    ...user,
    passwordHash: hashPassword(Buffer.from(newHash, 'base64'), Buffer.from(user.salt, 'base64'), 600000).toString(
      'base64',
    ),
    akey: typeof jsonValue(body, 'key') === 'string' ? (jsonValue(body, 'key') as string) : user.akey,
    masterPasswordHint: typeof hint === 'string' ? hint : null,
    privateKey: typeof keys.privateKey === 'string' ? keys.privateKey : user.privateKey,
    publicKey: typeof keys.publicKey === 'string' ? keys.publicKey : user.publicKey,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    securityStamp: newUuid(),
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return jwtJson(200, {});
}

// GET /api/accounts/hint?email= — master password hint (vaultwarden
// password_hint, no auth). Empty hint answers {"masterPasswordHint": null}.
export async function passwordHint(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const email = (typeof params.email === 'string' ? params.email : ctx.query.email ?? '')
    .trim()
    .toLowerCase();
  if (email === '') throw new BitwardenError(400, 'Email is required.');
  const user = await ctx.store.getUserByEmail(email);
  return json(200, { masterPasswordHint: user?.masterPasswordHint ?? null });
}

// POST /api/accounts/password-hint — set/replace hint (auth, vaultwarden
// set_password_hint).
export async function setPasswordHint(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const hint = jsonValue(ctx.bodyJson, 'masterPasswordHint');
  await ctx.store.putUser({
    ...user,
    masterPasswordHint: typeof hint === 'string' && hint !== '' ? hint : null,
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  });
  return json(200, {});
}

// POST /api/accounts/kdf — verify, store kdf, rotate stamp.
export async function changeKdf(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  requirePassword(body, user);
  const kdf = normalizeKdf(jsonValue(body, 'kdf'), {
    type: user.kdfType,
    iterations: user.kdfIterations,
    memory: user.kdfMemory,
    parallelism: user.kdfParallelism,
  });
  await ctx.store.clearRememberedDevices(user.id);
  const updated: UserItem = {
    ...user,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    securityStamp: newUuid(),
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return jwtJson(200, {});
}

// POST /api/accounts/security-stamp — verify, rotate stamp (force logout).
export async function rotateSecurityStamp(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  await ctx.store.clearRememberedDevices(user.id);
  const updated: UserItem = {
    ...user,
    securityStamp: newUuid(),
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return jwtJson(200, {});
}

// POST /api/accounts/verify-password — policy shape per research §2.2.
export async function verifyPassword(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  requirePassword(ctx.bodyJson as Record<string, unknown>, ctx.user!);
  return jwtJson(200, { MasterPasswordPolicy: { Object: 'masterPasswordPolicy' } });
}

// POST /api/accounts/delete + DELETE /api/accounts.
export async function deleteAccount(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  for (const cipher of await ctx.store.listCiphers(user.id)) {
    await ctx.objects.deletePrefix(`attachments/${cipher.id}/`);
  }
  for (const send of await ctx.store.listSends(user.id)) {
    if (send.type === 1) await ctx.objects.deletePrefix(`sends/${send.id}/`);
  }
  await ctx.store.deleteUser(user.id);
  return jwtJson(200, {});
}

// PUT|POST /api/accounts/profile — {name, avatarColor?}.
export async function updateProfile(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  const updated: UserItem = {
    ...user,
    name: typeof body.name === 'string' ? body.name : user.name,
    avatarColor: typeof body.avatarColor === 'string' ? body.avatarColor : user.avatarColor,
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return jwtJson(200, profileJson(updated, await userOrgsJson(ctx)));
}