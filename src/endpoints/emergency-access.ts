import { newUuid, hashPassword } from '../crypto';
import { issueSession } from '../auth';
import { authenticatedResponse } from './identity';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { EmergencyAccessItem, UserItem } from '../store';
import { cipherJson } from './ciphers';
import { folderJson } from './folders';
import { collectionJson } from './collections';
import { orgJson } from './organizations';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const STATUS_INVITED = 0;
const STATUS_ACCEPTED = 1;
const STATUS_CONFIRMED = 2;
const STATUS_INITIATED = 3;
const STATUS_APPROVED = 4;

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function badRequest(message: string): BitwardenError {
  return new BitwardenError(400, message);
}

function notFoundErr(): BitwardenError {
  return new BitwardenError(404, 'Not found.');
}

function forbidden(message: string): BitwardenError {
  return new BitwardenError(403, message);
}

// Shared shape for every EA response model.
function granteeDetailsJson(item: EmergencyAccessItem): Record<string, unknown> {
  return {
    object: 'emergencyAccessGranteeDetails',
    id: item.itemId,
    email: item.email,
    name: item.name,
    type: item.type,
    status: item.status,
    waitTimeDays: item.waitTimeDays,
    creationDate: item.creationDate,
    revisionDate: item.revisionDate,
  };
}

function grantorDetailsJson(item: EmergencyAccessItem, grantor: UserItem): Record<string, unknown> {
  return {
    ...granteeDetailsJson(item),
    object: 'emergencyAccessGrantorDetails',
    email: grantor.email,
    name: grantor.name,
  };
}

// Grantor-side lookup: the caller must own the item.
async function getOwned(ctx: RouteContext, itemId: string): Promise<EmergencyAccessItem> {
  const item = await ctx.store.getEmergencyAccess(ctx.user!.id, itemId);
  if (!item) throw notFoundErr();
  return item;
}

// Grantee-side lookup: the caller must be the bound grantee.
async function getGranted(ctx: RouteContext, itemId: string): Promise<EmergencyAccessItem> {
  const mine = (await ctx.store.listEmergencyAccessForGrantee(ctx.user!.id)).find((i) => i.itemId === itemId);
  if (!mine) throw notFoundErr();
  return mine;
}

async function getGrantor(ctx: RouteContext, item: EmergencyAccessItem): Promise<UserItem> {
  const grantor = await ctx.store.getUser(item.grantorId);
  if (!grantor) throw notFoundErr();
  return grantor;
}

function updateRow(item: EmergencyAccessItem, change: Partial<EmergencyAccessItem>): EmergencyAccessItem {
  return { ...item, ...change, revisionDate: new Date().toISOString() };
}

// POST /api/emergency-access/invite {email, type, waitTimeDays}
// No-email flow: the accept token is surfaced in the response (plan 08-01).
export async function eaInvite(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email.includes('@')) throw badRequest('Invalid email address.');
  const type = Number(body.type ?? body.Type ?? -1);
  if (type !== 0 && type !== 1) throw badRequest('Invalid emergency access type.');
  const waitTimeDays = Number(body.waitTimeDays ?? body.WaitTimeDays ?? -1);
  if (!Number.isInteger(waitTimeDays) || waitTimeDays < 0 || waitTimeDays > 255) {
    throw badRequest('Invalid wait time.');
  }
  const existing = await ctx.store.listEmergencyAccessForGrantor(ctx.user!.id);
  if (existing.some((i) => i.email === email)) {
    throw badRequest('Emergency access already exists for this user.');
  }
  const id = newUuid();
  const now = new Date().toISOString();
  const item: EmergencyAccessItem = {
    pk: `EMERG#${ctx.user!.id}#${id}`,
    sk: 'EMERG',
    itemId: id,
    grantorId: ctx.user!.id,
    granteeId: null,
    email,
    status: STATUS_INVITED,
    type,
    waitTimeDays,
    token: newUuid(),
    name: null,
    encryptedPrivateKey: null,
    publicKey: null,
    encryptedKey: null,
    creationDate: now,
    revisionDate: now,
    GSI1PK: '',
    GSI1SK: 'EMERG',
  };
  await ctx.store.putEmergencyAccess({ ...item, GSI1PK: `EMERGTOKEN#${item.token}` });
  return json(200, { ...granteeDetailsJson(item), token: item.token });
}

// POST /api/emergency-access/{id}/reinvite — regenerates the accept token.
export async function eaReinvite(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  if (item.status !== STATUS_INVITED) throw badRequest('Invalid emergency access.');
  const token = newUuid();
  const updated = updateRow(item, { token, GSI1PK: `EMERGTOKEN#${token}` });
  await ctx.store.putEmergencyAccess(updated);
  return json(200, { ...granteeDetailsJson(updated), token });
}

// POST /api/emergency-access/{id}/accept {token, name?, encryptedPrivateKey?, publicKey?}
// Authed accept (existing-user path). Register-with-token binds in identity.ts.
export async function eaAccept(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson as Record<string, unknown>;
  if (typeof body.token !== 'string' || body.token === '') throw badRequest('Invalid token.');
  const item = await ctx.store.getEmergencyAccessByToken(body.token);
  if (!item || item.itemId !== params.id) throw notFoundErr();
  if (item.status !== STATUS_INVITED || item.granteeId) throw badRequest('Invitation has already been accepted.');
  const granteeId = ctx.user!.id;
  const keys = (ctx.bodyJson.keys ?? {}) as Record<string, unknown>;
  await ctx.store.putEmergencyAccess({
    ...item,
    granteeId,
    name: typeof body.name === 'string' && body.name !== '' ? body.name : ctx.user!.name,
    encryptedPrivateKey:
      typeof body.encryptedPrivateKey === 'string'
        ? body.encryptedPrivateKey
        : typeof keys.privateKey === 'string'
          ? keys.privateKey
          : null,
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : typeof keys.publicKey === 'string' ? keys.publicKey : null,
    token: null,
    GSI1PK: `EMERGGRANTEE#${granteeId}`,
    status: STATUS_ACCEPTED,
    revisionDate: new Date().toISOString(),
  });
  return json(200, {});
}

// POST /api/emergency-access/{id}/confirm {key} — grantor seals the vault key
// to the grantee's public key; the wait time starts at confirmation.
export async function eaConfirm(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  const key = (ctx.bodyJson as Record<string, unknown>).key;
  if (typeof key !== 'string' || key === '') throw badRequest('Invalid key.');
  if (item.status !== STATUS_ACCEPTED) throw badRequest('Invalid emergency access.');
  await ctx.store.putEmergencyAccess(updateRow(item, { encryptedKey: key, status: STATUS_CONFIRMED }));
  return json(200, {});
}

// PUT|POST /api/emergency-access/{id} {type?, waitTimeDays?}
export async function eaUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  const body = ctx.bodyJson as Record<string, unknown>;
  const type = body.type === undefined ? null : Number(body.type);
  const waitTimeDays = body.waitTimeDays === undefined ? null : Number(body.waitTimeDays);
  if (type !== null && type !== 0 && type !== 1) throw badRequest('Invalid emergency access type.');
  if (waitTimeDays !== null && (!Number.isInteger(waitTimeDays) || waitTimeDays < 0 || waitTimeDays > 255)) {
    throw badRequest('Invalid wait time.');
  }
  await ctx.store.putEmergencyAccess(
    updateRow(item, {
      type: type ?? item.type,
      waitTimeDays: waitTimeDays ?? item.waitTimeDays,
    }),
  );
  return json(200, {});
}

// DELETE /api/emergency-access/{id} + POST /{id}/delete
export async function eaDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  await ctx.store.deleteEmergencyAccess(item.grantorId, item.itemId);
  return json(200, {});
}

// GET /api/emergency-access/trusted — grantor's view of invited grantees.
export async function eaTrusted(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const items = await ctx.store.listEmergencyAccessForGrantor(ctx.user!.id);
  return json(200, items.map(granteeDetailsJson));
}

// GET /api/emergency-access/granted — grantee's view of grantors.
export async function eaGranted(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const items = await ctx.store.listEmergencyAccessForGrantee(ctx.user!.id);
  const out: Record<string, unknown>[] = [];
  for (const item of items) out.push(grantorDetailsJson(item, await getGrantor(ctx, item)));
  return json(200, out);
}

// GET /api/emergency-access/{id} — grantor's single-item detail.
export async function eaGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  return json(200, { ...granteeDetailsJson(item), granteeId: item.granteeId });
}

// POST /api/emergency-access/{id}/initiate — grantee asks for access after the wait window.
export async function eaInitiate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = (await ctx.store.listEmergencyAccessForGrantee(ctx.user!.id)).find((i) => i.itemId === params.id);
  if (!item) throw notFoundErr();
  if (item.status !== STATUS_CONFIRMED) throw badRequest('Invalid emergency access.');
  const waitMs = item.waitTimeDays * 86400000;
  if (Date.parse(item.revisionDate) + waitMs > Date.now()) throw badRequest('The wait time has not yet elapsed.');
  await ctx.store.putEmergencyAccess(updateRow(item, { status: STATUS_INITIATED }));
  return json(200, {});
}

// POST /api/emergency-access/{id}/approve | reject — grantor answers the request.
export async function eaApprove(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  if (item.status !== STATUS_INITIATED) throw badRequest('Invalid emergency access.');
  await ctx.store.putEmergencyAccess(updateRow(item, { status: STATUS_APPROVED }));
  return json(200, {});
}

export async function eaReject(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getOwned(ctx, params.id);
  if (item.status !== STATUS_INITIATED) throw badRequest('Invalid emergency access.');
  await ctx.store.putEmergencyAccess(updateRow(item, { status: STATUS_CONFIRMED }));
  return json(200, {});
}

// POST /api/emergency-access/{id}/view — grantee reads the grantor's vault.
export async function eaView(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getGranted(ctx, params.id);
  if (item.status !== STATUS_APPROVED) throw forbidden('Emergency access is not approved.');
  const grantor = await getGrantor(ctx, item);
  const memberships = await ctx.store.listOrganizationsForUser(grantor.id);
  const policies: Record<string, unknown>[] = [];
  for (const m of memberships) {
    if (m.status < 2) continue;
    for (const p of await ctx.store.listPolicies(m.orgId)) {
      policies.push({ object: 'policy', id: p.id, organizationId: p.organizationId, type: p.type, enabled: p.enabled, data: p.data });
    }
  }
  const orgsJson: Record<string, unknown>[] = [];
  for (const m of memberships) {
    const org = await ctx.store.getOrganization(m.orgId);
    if (org) orgsJson.push(orgJson(org, m));
  }
  const ciphers = await ctx.store.listCiphersForUser(grantor.id);
  return json(200, {
    ciphers: await Promise.all(ciphers.map((c) => cipherJson(c, 'cipherDetails', ctx.objects))),
    folders: (await ctx.store.listFolders(grantor.id)).map(folderJson),
    collections: (await ctx.store.listCollectionsForUser(grantor.id)).map((c) => collectionJson(c)),
    organizations: orgsJson,
    policies,
    encryptedKey: item.encryptedKey,
  });
}

// POST /api/emergency-access/{id}/takeover — grantee signs in as the grantor.
export async function eaTakeover(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getGranted(ctx, params.id);
  if (item.status !== STATUS_APPROVED) throw forbidden('Emergency access is not approved.');
  const grantor = await getGrantor(ctx, item);
  const pair = await issueSession(ctx.store, grantor, ctx.session!.deviceId);
  return authenticatedResponse(grantor, pair);
}

// POST /api/emergency-access/{id}/password {newMasterPasswordHash, key} —
// reset the grantor's password + vault key; the trust resets to confirmed.
export async function eaPassword(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await getGranted(ctx, params.id);
  if (item.status !== STATUS_APPROVED) throw forbidden('Emergency access is not approved.');
  const body = ctx.bodyJson as Record<string, unknown>;
  const newHash = body.newMasterPasswordHash;
  if (typeof newHash !== 'string' || newHash === '') throw badRequest('Invalid password.');
  const key = typeof body.key === 'string' && body.key !== '' ? body.key : null;
  const grantor = await getGrantor(ctx, item);
  await ctx.store.clearRememberedDevices(grantor.id);
  const updated: UserItem = {
    ...grantor,
    passwordHash: hashPassword(Buffer.from(newHash, 'base64'), Buffer.from(grantor.salt, 'base64'), 600000).toString('base64'),
    akey: key ?? grantor.akey,
    securityStamp: newUuid(),
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  await ctx.store.putEmergencyAccess(updateRow(item, { status: STATUS_CONFIRMED }));
  return json(200, {});
}

// GET /api/emergency-access/{id}/policies — org policies before takeover.
// ponytail: always empty; grantor org policies shape from the orgs phase lands later.
export async function eaPolicies(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await getOwned(ctx, params.id);
  return json(200, { Data: [], Object: 'listResponse' });
}