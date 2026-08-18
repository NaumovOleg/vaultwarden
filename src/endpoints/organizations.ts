import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { OrganizationItem, OrgUserItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function notFoundErr() {
  return new BitwardenError(404, 'Not found.');
}

function forbidden(message: string): BitwardenError {
  return new BitwardenError(403, message);
}

// Capability flags: this server relays everything clients need, so all use*
// are true. Shape follows vaultwarden OrganizationResponseModel.
export function orgJson(org: OrganizationItem, member: OrgUserItem): Record<string, unknown> {
  return {
    id: org.id,
    identifier: null,
    name: org.name,
    businessName: null,
    billingEmail: org.billingEmail,
    key: org.key,
    status: member.status,
    type: member.type,
    usePolicies: true,
    useSso: false,
    useKeyConnector: false,
    useScim: false,
    useGroups: true,
    useDirectory: false,
    useEvents: false,
    useTotp: true,
    use2fa: false,
    useApi: false,
    useResetPassword: false,
    usePasswordManager: true,
    limitCollectionCreation: false,
    limitCollections: false,
    limitItemDeletion: false,
    showVault: true,
    sync: false,
    maxCollections: null,
    maxStorageGb: null,
    selfHost: true,
    hasPublicAndPrivateKeys: true,
    usersGetPremium: true,
    enabled: true,
    object: 'organization',
  };
}

async function requireOrg(
  ctx: RouteContext,
  orgId: string,
  maxType = 3,
): Promise<{ org: OrganizationItem; member: OrgUserItem }> {
  const org = await ctx.store.getOrganization(orgId);
  if (!org) throw notFoundErr();
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  if (member.type > maxType) throw forbidden('You do not have permission to do this.');
  return { org, member };
}

// POST /api/organizations {name, billingEmail?, key, keys, collectionName?}
export async function orgCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new BitwardenError(400, 'Organization name is required.');
  const id = newUuid();
  const now = new Date().toISOString();
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const org: OrganizationItem = {
    pk: `ORG#${id}`,
    sk: 'ORG',
    id,
    name,
    billingEmail: typeof body.billingEmail === 'string' ? body.billingEmail : user.email,
    key: typeof body.key === 'string' ? body.key : '',
    keys: {
      publicKey: typeof keys.publicKey === 'string' ? keys.publicKey : '',
      privateKey: typeof keys.privateKey === 'string' ? keys.privateKey : '',
    },
    createdAt: now,
    revisionDate: now,
  };
  await ctx.store.putOrganization(org);
  await ctx.store.putOrgUser({
    pk: `ORGUSER#${id}#${user.id}`,
    sk: 'ORGUSER',
    id: user.id,
    orgId: id,
    userId: user.id,
    email: user.email,
    status: 2,
    type: 0,
    accessToken: null,
    revisionDate: now,
  });
  if (typeof body.collectionName === 'string' && body.collectionName !== '') {
    const collectionId = newUuid();
    await ctx.store.putCollection({
      pk: `COLLECTION#${id}#${collectionId}`,
      sk: 'COLLECTION',
      id: collectionId,
      organizationId: id,
      name: body.collectionName,
      externalId: null,
      hidePasswords: false,
      readOnly: false,
      manage: true,
      users: [{ id: user.id, readOnly: false, hidePasswords: false }],
      revisionDate: now,
    });
  }
  return json(200, {});
}

// GET /api/organizations/{id}
export async function orgGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org, member } = await requireOrg(ctx, params.id);
  return json(200, orgJson(org, member));
}

// PUT|POST /api/organizations/{id} {name?, billingEmail?}
export async function orgUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org } = await requireOrg(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const updated: OrganizationItem = {
    ...org,
    name: typeof body.name === 'string' ? body.name : org.name,
    billingEmail: typeof body.billingEmail === 'string' ? body.billingEmail : org.billingEmail,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putOrganization(updated);
  return json(200, {});
}

// POST /api/organizations/{id}/keys {publicKey, privateKey, key}
export async function orgSetKeys(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org } = await requireOrg(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const updated: OrganizationItem = {
    ...org,
    key: typeof body.key === 'string' ? body.key : org.key,
    keys: {
      publicKey: typeof body.publicKey === 'string' ? body.publicKey : typeof keys.publicKey === 'string' ? keys.publicKey : org.keys.publicKey,
      privateKey: typeof body.privateKey === 'string' ? body.privateKey : typeof keys.privateKey === 'string' ? keys.privateKey : org.keys.privateKey,
    },
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putOrganization(updated);
  return json(200, {});
}

// GET /api/organizations/{id}/keys
export async function orgGetKeys(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org } = await requireOrg(ctx, params.id);
  return json(200, { publicKey: org.keys.publicKey, privateKey: org.keys.privateKey, key: org.key });
}

// GET /api/organizations/{id}/public-key
export async function orgPublicKey(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org } = await requireOrg(ctx, params.id);
  return json(200, { publicKey: org.keys.publicKey });
}

// POST|DELETE /api/organizations/{id}/delete — owner-only, cascades rows.
export async function orgDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org } = await requireOrg(ctx, params.id, 0);
  const collections = await ctx.store.listCollectionsForOrg(org.id);
  for (const col of collections) await ctx.store.deleteCollection(org.id, col.id);
  await ctx.store.deleteOrganization(org.id);
  return json(200, {});
}

// POST /api/organizations/{id}/leave
export async function orgLeave(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { org, member } = await requireOrg(ctx, params.id);
  if (member.type === 0) {
    const owners = (await ctx.store.listOrgUsers(org.id)).filter((m) => m.type === 0);
    if (owners.length <= 1) throw forbidden('The last owner cannot leave the organization.');
  }
  await ctx.store.deleteOrgUser(org.id, ctx.user!.id);
  return json(200, {});
}
