import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { OrgUserItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

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

async function requireOrgMember(ctx: RouteContext, orgId: string, minType = 0): Promise<OrgUserItem> {
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  if (member.type > minType) throw forbidden('You do not have permission to do this.');
  return member;
}

async function memberById(ctx: RouteContext, orgId: string, memberId: string): Promise<OrgUserItem> {
  const member = await ctx.store.getOrgUser(orgId, memberId);
  if (!member) throw notFoundErr();
  return member;
}

// Capability flags follow vaultwarden OrganizationUserResponseModel.
export function memberJson(member: OrgUserItem, name: string | null): Record<string, unknown> {
  return {
    object: 'organizationUser',
    id: member.id,
    organizationId: member.orgId,
    accessAll: true,
    externalId: null,
    twoFactorEnabled: false,
    status: member.status,
    type: member.type,
    permissions: {
      accessEventLogs: false,
      accessImportExport: false,
      accessReports: false,
      createNewCollections: true,
      editAnyCollection: true,
      deleteAnyCollection: true,
      manageGroups: false,
      managePolicies: member.type <= 1,
      manageSso: false,
      manageUsers: member.type <= 1,
      manageResetPassword: false,
    },
    revisionDate: member.revisionDate,
    collections: [],
    name,
    email: member.email,
  };
}

async function ownerGuard(ctx: RouteContext, member: OrgUserItem, demote: boolean): Promise<void> {
  if (member.type !== 0 || demote === false) return;
  const owners = (await ctx.store.listOrgUsers(member.orgId)).filter((m) => m.type === 0 && m.status >= 2);
  if (owners.length <= 1) throw badRequest('You cannot remove the last owner.');
}

// POST /api/organizations/{id}/users/invite {emails:[{email,type}]}
// No-email flow: response relays accessToken per invite so the UI can build
// accept links; Bitwarden's response is empty here (extension, documented in plan).
export async function memberInvite(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const caller = await requireOrgMember(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const existing = new Set((await ctx.store.listOrgUsers(params.id)).map((m) => m.email));
  const seen = new Set<string>();
  const invites: { email: string; accessToken: string }[] = [];
  const now = new Date().toISOString();
  for (const e of emails) {
    const email = typeof e.email === 'string' ? e.email.trim().toLowerCase() : '';
    if (email === '') continue;
    if (existing.has(email) || seen.has(email)) throw badRequest('User is already a member.');
    const type = Number.isInteger(e.type) && e.type >= 0 && e.type <= 3 ? e.type : 2;
    if (caller.type !== 0 && type <= 1) throw forbidden('Only owners can invite owners or admins.');
    const id = newUuid();
    const accessToken = newUuid();
    await ctx.store.putOrgUser({
      pk: `ORGUSER#${params.id}#${id}`,
      sk: 'ORGUSER',
      id,
      orgId: params.id,
      userId: null,
      email,
      status: 0,
      type,
      accessToken,
      revisionDate: now,
    });
    seen.add(email);
    invites.push({ email, accessToken });
  }
  return json(200, { invites });
}

async function reinviteOne(ctx: RouteContext, orgId: string, memberId: string) {
  const member = await memberById(ctx, orgId, memberId);
  if (member.status !== 0) throw badRequest('Invalid user.');
  const token = newUuid();
  await ctx.store.putOrgUser({ ...member, accessToken: token, revisionDate: new Date().toISOString() });
  return json(200, { invites: [{ email: member.email, accessToken: token }] });
}

export async function memberReinvite(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 1);
  return reinviteOne(ctx, params.id, params.memberId);
}

export async function memberReinviteBulk(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((u): u is string => typeof u === 'string') : [];
  const invites: { email: string; accessToken: string }[] = [];
  for (const userId of userIds) {
    const member = await memberById(ctx, params.id, userId);
    if (member.status !== 0) continue;
    const token = newUuid();
    await ctx.store.putOrgUser({ ...member, accessToken: token, revisionDate: new Date().toISOString() });
    invites.push({ email: member.email, accessToken: token });
  }
  return json(200, { invites });
}

// GET /api/organizations/{id}/users?search=  (mini-details=true skips name lookup)
async function memberList(ctx: RouteContext, orgId: string, mini: boolean) {
  await requireOrgMember(ctx, orgId, 3);
  const search = String(ctx.query.search ?? '').trim().toLowerCase();  const members = await ctx.store.listOrgUsers(orgId);
  const out: Record<string, unknown>[] = [];
  for (const m of members) {
    if (search !== '' && !m.email.includes(search)) continue;
    let name: string | null = null;
    if (!mini && m.userId) {
      const user = await ctx.store.getUser(m.userId);
      name = user?.name ?? null;
    }
    out.push(memberJson(m, name));
  }
  return json(200, out);
}

export async function memberListAll(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return memberList(ctx, params.id, false);
}

export async function memberListMini(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return memberList(ctx, params.id, true);
}

// PUT|POST /api/organizations/{id}/users/{memberId} {type}
export async function memberUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const caller = await requireOrgMember(ctx, params.id, 1);
  const member = await memberById(ctx, params.id, params.memberId);
  const body = ctx.bodyJson;
  const type = Number.isInteger(body.type) && body.type >= 0 && body.type <= 3 ? body.type : null;
  if (type === null) throw badRequest('Invalid type.');
  if (caller.type !== 0 && (member.type <= 1 || type <= 1)) throw forbidden('Only owners can manage owners or admins.');
  if (type !== 0 && member.type === 0) await ownerGuard(ctx, member, true);
  await ctx.store.putOrgUser({ ...member, type, revisionDate: new Date().toISOString() });
  return json(200, {});
}

// DELETE /api/organizations/{id}/users/{memberId}
export async function memberDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const caller = await requireOrgMember(ctx, params.id, 1);
  const member = await memberById(ctx, params.id, params.memberId);
  if (caller.type !== 0 && member.type <= 1) throw forbidden('Only owners can remove owners or admins.');
  if (member.type === 0) await ownerGuard(ctx, member, true);
  await ctx.store.deleteOrgUser(params.id, member.id);
  return json(200, {});
}

// POST /api/organizations/{id}/users/delete {userIds:[]}
export async function memberDeleteBulk(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const caller = await requireOrgMember(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((u): u is string => typeof u === 'string') : [];
  const orgId = params.id;
  for (const userId of userIds) {
    const member = await memberById(ctx, orgId, userId);
    if (caller.type !== 0 && member.type <= 1) throw forbidden('Only owners can remove owners or admins.');
    if (member.type === 0) await ownerGuard(ctx, member, true);
    await ctx.store.deleteOrgUser(orgId, member.id);
  }
  return json(200, {});
}

export async function memberRevoke(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const caller = await requireOrgMember(ctx, params.id, 1);
  const member = await memberById(ctx, params.id, params.memberId);
  if (caller.type !== 0 && member.type <= 1) throw forbidden('Only owners can revoke owners or admins.');
  if (member.type === 0) await ownerGuard(ctx, member, true);
  await ctx.store.putOrgUser({ ...member, status: -1, revisionDate: new Date().toISOString() });
  return json(200, {});
}

export async function memberRestore(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 1);
  const member = await memberById(ctx, params.id, params.memberId);
  await ctx.store.putOrgUser({ ...member, status: 2, revisionDate: new Date().toISOString() });
  return json(200, {});
}

// POST /api/organizations/{id}/users/public-keys {userIds:[]}
export async function memberPublicKeys(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 1);
  const body = ctx.bodyJson;
  const userIds = Array.isArray(body.userIds) ? body.userIds.filter((u): u is string => typeof u === 'string') : [];
  const members = await ctx.store.listOrgUsers(params.id);
  const out: Record<string, unknown>[] = [];
  for (const m of members) {
    if (!m.userId || !userIds.includes(m.userId)) continue;
    const user = await ctx.store.getUser(m.userId);
    out.push({ userId: m.userId, publicKey: user?.publicKey ?? null, key: null });
  }
  return json(200, out);
}

// POST /api/organizations/{id}/users/{memberId}/accept {token, name?, organizationUserId?}
// Binds the invitation to the signed-in account (no-email flow) and confirms it.
export async function memberAccept(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const member = await memberById(ctx, params.id, params.memberId);
  const body = ctx.bodyJson;
  if (typeof body.token !== 'string' || body.token === '' || member.accessToken !== body.token) {
    throw badRequest('Invalid token.');
  }
  if (member.status !== 0) throw badRequest('Invitation has already been accepted.');
  if (typeof body.organizationUserId === 'string' && body.organizationUserId !== member.id) {
    throw badRequest('Invitation is for a different user.');
  }
  if (member.userId && member.userId !== ctx.user!.id) throw badRequest('Invitation is for a different user.');
  const now = new Date().toISOString();
  await ctx.store.deleteOrgUser(member.orgId, member.id);
  await ctx.store.putOrgUser({
    ...member,
    pk: `ORGUSER#${member.orgId}#${ctx.user!.id}`,
    id: ctx.user!.id,
    userId: ctx.user!.id,
    status: 2,
    accessToken: null,
    revisionDate: now,
  });
  return json(200, {});
}
