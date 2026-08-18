import type { RouteContext } from '../router';
import type { UserItem } from '../store';
import { cipherJson } from './ciphers';
import { folderJson } from './folders';
import { sendJson } from './sends';
import { orgJson } from './organizations';
import { collectionJson } from './collections';
import { newUuid, hashPassword } from '../crypto';
import { verifyClientHash } from '../auth';
import { BitwardenError } from '../errors';
import { jsonValue, normalizeKdf } from './identity';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

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
          encryptedPrivateKey: user.privateKey,
          publicKey: user.publicKey,
          object: 'keyPair',
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
    accountKeys: {
      publicKeyEncryptionKeyPair: keyPair,
      securityState: null,
      signatureKeyPair: null,
      object: 'privateKeys',
    },
    object: 'profile',
  };
}

export { profileJson };

function domainsJson() {
  return { equivalentDomains: [], globalEquivalentDomains: [], object: 'domains' };
}

function userDecryptionJson(user: UserItem) {
  return {
    masterPasswordUnlock:
      user.masterKeyEncryptedUserKey || user.masterKeyWrappedUserKey
        ? {
            kdf: {
              kdfType: user.kdfType,
              kdfIterations: user.kdfIterations,
              kdfMemory: user.kdfMemory,
              kdfParallelism: user.kdfParallelism,
            },
            masterKeyEncryptedUserKey: user.masterKeyEncryptedUserKey,
            masterKeyWrappedUserKey: user.masterKeyWrappedUserKey,
            salt: user.email,
          }
        : null,
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