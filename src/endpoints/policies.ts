import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { PolicyItem } from '../store';

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

async function requireOrgMember(ctx: RouteContext, orgId: string, minType = 0) {
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  if (member.type > minType) throw forbidden('You do not have permission to do this.');
  return member;
}

function policyJson(policy: PolicyItem): Record<string, unknown> {
  return {
    object: 'policy',
    id: policy.id,
    organizationId: policy.organizationId,
    type: policy.type,
    enabled: policy.enabled,
    data: policy.data,
  };
}

function parseType(raw: string): number {
  const type = Number(raw);
  if (!Number.isInteger(type) || type < 0 || type > 14) throw badRequest('Invalid policy type.');
  return type;
}

// GET /api/organizations/{id}/policies
export async function policyList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 3);
  const policies = await ctx.store.listPolicies(params.id);
  return json(200, policies.map(policyJson));
}

// GET /api/organizations/{id}/policies/{polType}
export async function policyGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 3);
  const policy = await ctx.store.getPolicy(params.id, parseType(params.polType));
  if (!policy) throw notFoundErr();
  return json(200, policyJson(policy));
}

// PUT /api/organizations/{id}/policies/{polType} {enabled, data?}
export async function policyUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  await requireOrgMember(ctx, params.id, 1);
  const type = parseType(params.polType);
  const body = ctx.bodyJson;
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled is required.');
  const existing = await ctx.store.getPolicy(params.id, type);
  const policy: PolicyItem = existing ?? {
    pk: `ORG#${params.id}#POLICY#${type}`,
    sk: 'POLICY',
    id: newUuid(),
    organizationId: params.id,
    type,
    enabled: false,
    data: '{}',
  };
  await ctx.store.putPolicy({ ...policy, enabled: body.enabled, data: JSON.stringify(body.data ?? {}) });
  return json(200, policyJson({ ...policy, enabled: body.enabled, data: JSON.stringify(body.data ?? {}) }));
}
