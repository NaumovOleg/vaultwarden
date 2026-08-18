import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { CollectionItem, CollectionUserRef } from '../store';

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

export function collectionJson(col: CollectionItem, object: 'collection' | 'collectionDetails' = 'collectionDetails') {
  return {
    id: col.id,
    organizationId: col.organizationId,
    name: col.name,
    externalId: col.externalId,
    hidePasswords: col.hidePasswords,
    readOnly: col.readOnly,
    manage: col.manage,
    revisionDate: col.revisionDate,
    object,
  };
}

function usersFromBody(body: Record<string, any>): CollectionUserRef[] {
  const out: CollectionUserRef[] = [];
  if (Array.isArray(body.users)) {
    for (const u of body.users) {
      if (u && typeof u === 'object' && typeof u.id === 'string') {
        out.push({
          id: u.id,
          readOnly: u.readOnly === true,
          hidePasswords: u.hidePasswords === true,
        });
      }
    }
  }
  return out;
}

async function requireOrgAccess(ctx: RouteContext, orgId: string, minType = 2): Promise<void> {
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  if (member.type > minType) throw forbidden('You do not have permission to do this.');
}

async function requireCollection(
  ctx: RouteContext,
  orgId: string,
  collectionId: string,
): Promise<CollectionItem> {
  const col = await ctx.store.getCollection(orgId, collectionId);
  if (!col) throw notFoundErr();
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  if (member.type > 1 && !col.users.some((u) => u.id === ctx.user!.id)) throw notFoundErr();
  return col;
}

// GET /api/collections — accessible collections across orgs.
export async function collectionListAll(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const cols = await ctx.store.listCollectionsForUser(ctx.user!.id);
  return json(200, cols.map((c) => collectionJson(c)));
}

// GET /api/organizations/{id}/collections (+ /details same shape)
export async function collectionListForOrg(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgAccess(ctx, params.id);
  const cols = await ctx.store.listCollectionsForOrg(params.id);
  return json(200, cols.map((c) => collectionJson(c)));
}

// GET /api/organizations/{id}/collections/{colId}/details
export async function collectionGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const col = await requireCollection(ctx, params.id, params.collectionId);
  return json(200, collectionJson(col));
}

// POST /api/organizations/{id}/collections {name, externalId?, users?}
export async function collectionCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgAccess(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new BitwardenError(400, 'Collection name is required.');
  let users = usersFromBody(body);
  if (users.length === 0) {
    // default: all confirmed members (plan 01 scope: owner/admin/user)
    users = (await ctx.store.listOrgUsers(params.id))
      .filter((m) => m.status === 2)
      .map((m) => ({ id: m.userId ?? m.id, readOnly: false, hidePasswords: false }));
  }
  const id = newUuid();
  const col: CollectionItem = {
    pk: `COLLECTION#${params.id}#${id}`,
    sk: 'COLLECTION',
    id,
    organizationId: params.id,
    name,
    externalId: typeof body.externalId === 'string' ? body.externalId : null,
    hidePasswords: body.hidePasswords === true,
    readOnly: body.readOnly === true,
    manage: body.manage === true,
    users,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCollection(col);
  return json(200, {});
}

// PUT|POST /api/organizations/{id}/collections/{colId} {name?, externalId?, users?}
export async function collectionUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgAccess(ctx, params.id, 1);
  const existing = await ctx.store.getCollection(params.id, params.collectionId);
  if (!existing) throw notFoundErr();
  const body = ctx.bodyJson;
  const updated: CollectionItem = {
    ...existing,
    name: typeof body.name === 'string' ? body.name : existing.name,
    externalId: body.externalId !== undefined ? (typeof body.externalId === 'string' ? body.externalId : null) : existing.externalId,
    hidePasswords: body.hidePasswords !== undefined ? body.hidePasswords === true : existing.hidePasswords,
    readOnly: body.readOnly !== undefined ? body.readOnly === true : existing.readOnly,
    manage: body.manage !== undefined ? body.manage === true : existing.manage,
    users: body.users !== undefined ? usersFromBody(body) : existing.users,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCollection(updated);
  return json(200, {});
}

// DELETE /api/organizations/{id}/collections/{colId} + POST .../{colId}/delete
export async function collectionDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgAccess(ctx, params.id, 1);
  const existing = await ctx.store.getCollection(params.id, params.collectionId);
  if (!existing) throw notFoundErr();
  await ctx.store.deleteCollection(params.id, params.collectionId);
  return json(200, {});
}
