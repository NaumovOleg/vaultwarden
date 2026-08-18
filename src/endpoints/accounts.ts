import type { RouteContext } from '../router';
import type { UserItem } from '../store';
import { cipherJson } from './ciphers';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// Shared profile serializer — used by GET /api/accounts/profile and /api/sync.
function profileJson(user: UserItem) {
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
    organizations: [],
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
  return json(200, profileJson(ctx.user!));
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
  const folderJson = folders.map((f) => ({
    id: f.id,
    name: f.name,
    revisionDate: f.revisionDate,
    object: 'folder',
  }));

  const bundle: Record<string, unknown> = {
    profile: profileJson(user),
    folders: folderJson,
    object: 'sync',
  };

  if (partial) return json(200, bundle);

  const ciphers = await ctx.store.listCiphers(user.id);
  return json(200, {
    ...bundle,
    collections: [],
    policies: [],
    ciphers: ciphers.map((c) => cipherJson(c, 'cipherDetails')),
    domains: excludeDomains ? null : domainsJson(),
    sends: [],
    userDecryption: userDecryptionJson(user),
  });
}