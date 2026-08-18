import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { CipherItem } from '../store';
import type { ObjectStore } from '../objects';
import { parseBodyBytes } from './multipart';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function notFoundErr() {
  return new BitwardenError(404, 'Not found.');
}

// Human bytes, e.g. "4.5 MB" (vaultwarden size_name).
function sizeName(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

// Canonical serializer (pitfall 1.5: type payload strictly separated, never
// folded; explicit nulls — pitfall 2.5). Encrypted strings relayed verbatim.
// Attachments serialize with a fresh 5-min presigned url; trashed items get
// blank urls (restore re-arms them on next read).
async function cipherJson(item: CipherItem, object: 'cipher' | 'cipherDetails', objects: ObjectStore) {
  const attachments =
    item.attachments && item.attachments.length > 0
      ? await Promise.all(
          item.attachments.map(async (a) => ({
            ...a,
            url: item.deletedDate === null ? await objects.presignedGetUrl(`attachments/${item.id}/${a.id}`) : '',
          })),
        )
      : null;
  return {
    object,
    id: item.id,
    type: item.type,
    creationDate: item.creationDate,
    revisionDate: item.revisionDate,
    deletedDate: item.deletedDate,
    reprompt: item.reprompt,
    organizationId: item.organizationId,
    key: item.key,
    attachments,
    attachmentCount: item.attachments?.length ?? 0,
    organizationUseTotp: true,
    collectionIds: item.collectionIds ?? [],
    name: item.name,
    notes: item.notes,
    fields: item.fields,
    passwordHistory: item.passwordHistory,
    login: item.login,
    secureNote: item.secureNote,
    card: item.card,
    identity: item.identity,
    sshKey: item.sshKey,
    bankAccount: null,
    driversLicense: null,
    passport: null,
    edit: true,
    viewPassword: true,
    favorite: item.favorite,
    folderId: item.folderId,
    lastUsedDate: item.revisionDate,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Resolves a cipher to a row the caller may touch: personal, or an org cipher
// the user can see (any accessible collection). canWrite = owner/admin or a
// non-readOnly collection membership; org ciphers the user cannot see → 404.
async function resolveCipher(
  ctx: RouteContext,
  cipherId: string,
): Promise<{ item: CipherItem; orgId: string | null; canWrite: boolean }> {
  const personal = await ctx.store.getCipher(ctx.user!.id, cipherId);
  if (personal) return { item: personal, orgId: null, canWrite: true };
  const memberships = await ctx.store.listOrganizationsForUser(ctx.user!.id);
  for (const m of memberships) {
    if (m.status < 2) continue;
    const item = await ctx.store.getOrgCipher(m.orgId, cipherId);
    if (!item) continue;
    if (m.type <= 1) return { item, orgId: m.orgId, canWrite: true };
    const cols = await ctx.store.listCollectionsForOrg(m.orgId);
    let seen = false;
    let canWrite = false;
    for (const cid of item.collectionIds ?? []) {
      const col = cols.find((c) => c.id === cid);
      if (!col) continue;
      const mine = col.users.find((u) => u.id === ctx.user!.id);
      if (col.users.length === 0 || mine) {
        seen = true;
        if (!col.readOnly && !mine?.readOnly) canWrite = true;
      }
    }
    if (seen) return { item, orgId: m.orgId, canWrite };
  }
  throw notFoundErr();
}

async function requireOrgAdmin(ctx: RouteContext, orgId: string) {
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2 || member.type > 1) {
    throw new BitwardenError(403, 'Organization admin access required.');
  }
  return member;
}

function normalizeCreate(body: Record<string, any>): Omit<CipherItem, 'pk' | 'sk' | 'id' | 'createdAt'> {
  return {
    type: Number(body.type ?? 0),
    name: str(body.name),
    notes: body.notes === null || body.notes === undefined ? null : str(body.notes),
    favorite: body.favorite === true,
    reprompt: Number(body.reprompt ?? 0),
    folderId: typeof body.folderId === 'string' && body.folderId !== '' ? body.folderId : null,
    organizationId: null,
    creationDate: '',
    revisionDate: '',
    deletedDate: null,
    key: null,
    login:
      body.login && typeof body.login === 'object'
        ? {
            uris: Array.isArray(body.login.uris)
              ? body.login.uris.map((u: any) => ({
                  uri: str(u.uri),
                  match: u.match === null || u.match === undefined ? null : Number(u.match),
                }))
              : null,
            username: body.login.username === null || body.login.username === undefined ? null : str(body.login.username),
            password: body.login.password === null || body.login.password === undefined ? null : str(body.login.password),
            totp: body.login.totp === null || body.login.totp === undefined ? null : str(body.login.totp),
            passwordRevisionDate:
              body.login.passwordRevisionDate === null || body.login.passwordRevisionDate === undefined
                ? null
                : str(body.login.passwordRevisionDate),
            fido2Credentials: body.login.fido2Credentials ?? null,
          }
        : null,
    secureNote: body.secureNote && typeof body.secureNote === 'object' ? { type: Number(body.secureNote.type ?? 0) } : null,
    card: body.card && typeof body.card === 'object' ? body.card : null,
    identity: body.identity && typeof body.identity === 'object' ? body.identity : null,
    sshKey: body.sshKey && typeof body.sshKey === 'object' ? body.sshKey : null,
    bankAccount: body.bankAccount && typeof body.bankAccount === 'object' ? body.bankAccount : null,
    driversLicense: body.driversLicense && typeof body.driversLicense === 'object' ? body.driversLicense : null,
    passport: body.passport && typeof body.passport === 'object' ? body.passport : null,
    fields: Array.isArray(body.fields)
      ? body.fields.map((f: any) => ({
          name: f.name === null || f.name === undefined ? null : str(f.name),
          value: f.value === null || f.value === undefined ? null : str(f.value),
          type: Number(f.type ?? 0),
          linkedId: f.linkedId === null || f.linkedId === undefined ? null : Number(f.linkedId),
        }))
      : null,
    passwordHistory: Array.isArray(body.passwordHistory) ? body.passwordHistory : null,
    attachments: null,
    collectionIds: [],
  };
}

// GET /api/ciphers — non-deleted only
export async function cipherList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const all = await ctx.store.listCiphersForUser(ctx.user!.id);
  const data = await Promise.all(all.filter((c) => c.deletedDate === null).map((c) => cipherJson(c, 'cipherDetails', ctx.objects)));
  return json(200, { object: 'list', data, continuationToken: null });
}

// GET /api/ciphers/{id} and /api/ciphers/{id}/details
export async function cipherGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item } = await resolveCipher(ctx, params.cipherId);
  return json(200, await cipherJson(item, 'cipherDetails', ctx.objects));
}

// POST /api/ciphers + /api/ciphers/create
export async function cipherCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const now = new Date().toISOString();
  const content = normalizeCreate(ctx.bodyJson);
  const id = newUuid();
  const item: CipherItem = {
    ...content,
    pk: `CIPHER#${ctx.user!.id}#${id}`,
    sk: 'CIPHER',
    id,
    creationDate: now,
    revisionDate: now,
  };
  await ctx.store.putCipher(item);
  return json(200, await cipherJson(item, 'cipher', ctx.objects));
}

// PUT|POST /api/ciphers/{id} — full replace (personal or org cipher with write access)
export async function cipherUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, orgId, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to edit this cipher.');
  const updated: CipherItem = {
    ...item,
    ...normalizeCreate(ctx.bodyJson),
    pk: item.pk,
    sk: 'CIPHER',
    id: item.id,
    organizationId: item.organizationId,
    creationDate: item.creationDate,
    collectionIds: orgId
      ? Array.isArray(ctx.bodyJson.collectionIds)
        ? ctx.bodyJson.collectionIds.filter((s: unknown): s is string => typeof s === 'string')
        : item.collectionIds
      : [],
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCipher(updated);
  if (orgId && updated.collectionIds !== item.collectionIds) {
    await ctx.store.setOrgCipherCollections(orgId, item.id, updated.collectionIds);
  }
  return json(200, await cipherJson(updated, 'cipher', ctx.objects));
}

// PUT|POST /api/ciphers/{id}/partial — merge login fields only (extension autofill)
export async function cipherPartial(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to edit this cipher.');
  const login = ctx.bodyJson.login;
  const newLogin = {
    username: login?.username !== undefined ? str(login?.username) : (item.login?.username ?? null),
    password: login?.password !== undefined ? str(login?.password) : (item.login?.password ?? null),
    uris: Array.isArray(login?.uris)
      ? login.uris.map((u: any) => ({
          uri: str(u.uri),
          match: u.match === null || u.match === undefined ? null : Number(u.match),
        }))
      : (item.login?.uris ?? null),
    totp: login?.totp !== undefined ? str(login?.totp) : (item.login?.totp ?? null),
    passwordRevisionDate:
      login?.passwordRevisionDate !== undefined
        ? str(login?.passwordRevisionDate)
        : (item.login?.passwordRevisionDate ?? null),
    fido2Credentials: login?.fido2Credentials ?? item.login?.fido2Credentials ?? null,
  };
  const updated: CipherItem = {
    ...item,
    login: newLogin,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCipher(updated);
  return json(200, await cipherJson(updated, 'cipher', ctx.objects));
}

// DELETE|POST|PUT /api/ciphers/{id} (+ /delete) — soft delete
async function softDelete(ctx: RouteContext, cipherId: string): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to delete this cipher.');
  await ctx.store.putCipher({
    ...item,
    deletedDate: new Date().toISOString(),
    revisionDate: new Date().toISOString(),
  });
  return json(200, {});
}

export async function cipherDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return softDelete(ctx, params.cipherId);
}

// PUT|POST /api/ciphers/{id}/restore
export async function cipherRestore(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to restore this cipher.');
  await ctx.store.putCipher({
    ...item,
    deletedDate: null,
    revisionDate: new Date().toISOString(),
  });
  return json(200, {});
}

// PUT|POST /api/ciphers/{id}/move and /api/ciphers/move (bulk {folderId, ids})
export async function cipherMove(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { folderId, ids } = ctx.bodyJson;
  const idList: string[] = Array.isArray(ids) ? ids : params.cipherId ? [params.cipherId] : [];
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : null;
  for (const id of idList) {
    const { item, orgId, canWrite } = await resolveCipher(ctx, id);
    if (!canWrite) continue;
    // org ciphers live outside the personal folder tree
    const next = orgId ? { ...item } : { ...item, folderId: folder };
    await ctx.store.putCipher({ ...next, revisionDate: new Date().toISOString() });
  }
  return json(200, {});
}

// POST /api/ciphers/purge — permanent delete of trash rows (S3 objects cascade)
export async function cipherPurge(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const ids: unknown[] = ctx.bodyJson.ids ?? [];
  for (const id of ids) {
    if (typeof id === 'string') {
      const { orgId, canWrite } = await resolveCipher(ctx, id);
      if (!canWrite) continue;
      await ctx.objects.deletePrefix(`attachments/${id}/`);
      if (orgId) await ctx.store.deleteOrgCipher(orgId, id);
      else await ctx.store.deleteCipher(ctx.user!.id, id);
    }
  }
  return json(200, {});
}

// POST|PUT /api/ciphers/delete — bulk soft delete {ids}
export async function cipherBulkDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const ids: unknown[] = ctx.bodyJson.ids ?? [];
  for (const id of ids) {
    if (typeof id === 'string') await softDelete(ctx, id);
  }
  return json(200, {});
}

// POST /api/ciphers/import — {folders: [{name}], ciphers: [cipher objects],
// folderRelationships: [[folderIdx, cipherIdx]]}. Duplicates allowed (matches
// vaultwarden). Folder by index; missing index → null folderId.
// Max decodable upload bytes: Lambda invoke cap is 6 MB, API GW base64
// overhead cuts usable file size to ≈4.5 MB (ARCHITECTURE §4.1).
const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

function badBody(message: string): BitwardenError {
  return new BitwardenError(400, message);
}

// POST /api/ciphers/{cipherId}/attachment/v2 — {key, fileName, fileSize?}
// → {object:'attachment-fileUpload', attachmentId, url, fileUploadType:0, cipherResponse}.
export async function attachmentCreateV2(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to add attachments.');
  const body = ctx.bodyJson;
  const fileName = typeof body.fileName === 'string' ? body.fileName : '';
  const key = typeof body.key === 'string' ? body.key : '';
  if (fileName === '' || key === '') throw badBody('Missing fileName or key.');
  const attachmentId = newUuid();
  const size = typeof body.fileSize === 'number' ? body.fileSize : 0;
  const updated: CipherItem = {
    ...item,
    attachments: [
      ...(item.attachments ?? []),
      { id: attachmentId, url: '', fileName, key, size, sizeName: sizeName(size), object: 'attachment' },
    ],
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCipher(updated);
  return json(200, {
    object: 'attachment-fileUpload',
    attachmentId,
    url: `/api/ciphers/${item.id}/attachment/${attachmentId}`,
    fileUploadType: 0,
    cipherResponse: await cipherJson(updated, 'cipherDetails', ctx.objects),
  });
}

// POST /api/ciphers/{cipherId}/attachment/{attachmentId} — multipart {key, data}.
async function storeUpload(ctx: RouteContext, item: CipherItem, attachmentId: string): Promise<CipherItem> {
  const fields = parseBodyBytes(ctx.headers['content-type'] ?? '', ctx.bodyBytes);
  const data = fields.get('data');
  const key = fields.get('key')?.toString('utf-8');
  if (!data) throw badBody('Missing data field.');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new BitwardenError(413, 'Attachment exceeds the 4.5 MB limit.');
  }
  const existing = item.attachments?.find((a) => a.id === attachmentId);
  if (!existing) throw notFoundErr();
  const updated: CipherItem = {
    ...item,
    attachments: (item.attachments ?? []).map((a) =>
      a.id === attachmentId
        ? { ...a, size: data.length, sizeName: sizeName(data.length), key: key ?? a.key }
        : a,
    ),
    revisionDate: new Date().toISOString(),
  };
  await ctx.objects.putObject(`attachments/${item.id}/${attachmentId}`, data);
  await ctx.store.putCipher(updated);
  return updated;
}

export async function attachmentUpload(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to add attachments.');
  const updated = await storeUpload(ctx, item, params.attachmentId);
  return json(200, await cipherJson(updated, 'cipherDetails', ctx.objects));
}

// Legacy single-call: POST /api/ciphers/{cipherId}/attachment (multipart
// {key, data, fileName}) — create meta + upload in one call.
export async function attachmentLegacy(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to add attachments.');
  const fields = parseBodyBytes(ctx.headers['content-type'] ?? '', ctx.bodyBytes);
  const fileName = fields.get('fileName')?.toString('utf-8') ?? '';
  const key = fields.get('key')?.toString('utf-8') ?? '';
  const data = fields.get('data');
  if (!data) throw badBody('Missing data field.');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new BitwardenError(413, 'Attachment exceeds the 4.5 MB limit.');
  }
  const attachmentId = newUuid();
  const updated: CipherItem = {
    ...item,
    attachments: [
      ...(item.attachments ?? []),
      {
        id: attachmentId,
        url: '',
        fileName,
        key,
        size: data.length,
        sizeName: sizeName(data.length),
        object: 'attachment',
      },
    ],
    revisionDate: new Date().toISOString(),
  };
  await ctx.objects.putObject(`attachments/${item.id}/${attachmentId}`, data);
  await ctx.store.putCipher(updated);
  return json(200, await cipherJson(updated, 'cipherDetails', ctx.objects));
}

// GET /api/ciphers/{cipherId}/attachment/{attachmentId} — {object:'attachment',
// id, url (fresh presigned), fileName, key, size, sizeName}.
export async function attachmentGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const { item } = await resolveCipher(ctx, params.cipherId);
  const att = item.attachments?.find((a) => a.id === params.attachmentId);
  if (!att) throw notFoundErr();
  return json(200, {
    object: 'attachment',
    id: att.id,
    url: await ctx.objects.presignedGetUrl(`attachments/${item.id}/${att.id}`),
    fileName: att.fileName,
    key: att.key,
    size: att.size,
    sizeName: att.sizeName,
  });
}

// DELETE|POST|PUT /api/ciphers/{cipherId}/attachment/{attachmentId} (+ /delete)
async function attachmentDelete(ctx: RouteContext, cipherId: string, attachmentId: string): Promise<unknown> {
  const { item, canWrite } = await resolveCipher(ctx, cipherId);
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to delete attachments.');
  if (!item.attachments?.some((a) => a.id === attachmentId)) throw notFoundErr();
  const updated: CipherItem = {
    ...item,
    attachments: item.attachments.filter((a) => a.id !== attachmentId),
    revisionDate: new Date().toISOString(),
  };
  await ctx.objects.deleteObject(`attachments/${item.id}/${attachmentId}`);
  await ctx.store.putCipher(updated);
  return json(200, await cipherJson(updated, 'cipherDetails', ctx.objects));
}

export async function attachmentDeleteHandler(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  return attachmentDelete(ctx, params.cipherId, params.attachmentId);
}

export async function cipherImport(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson;
  const folderIds: string[] = [];
  const now = new Date().toISOString();
  if (Array.isArray(body.folders)) {
    for (const f of body.folders) {
      if (!f || typeof f !== 'object') {
        folderIds.push('');
        continue;
      }
      const name = typeof (f as any).name === 'string' ? (f as any).name : '';
      const id = newUuid();
      await ctx.store.putFolder({
        pk: `FOLDER#${user.id}#${id}`,
        sk: 'FOLDER',
        id,
        name,
        revisionDate: now,
      });
      folderIds.push(id);
    }
  }
  if (Array.isArray(body.ciphers)) {
    body.ciphers.forEach((raw: unknown, idx: number) => {
      if (!raw || typeof raw !== 'object') return;
      const content = normalizeCreate(raw as Record<string, any>);
      const id = newUuid();
      const rel = Array.isArray(body.folderRelationships) ? body.folderRelationships.find((r: unknown) => Array.isArray(r) && r[1] === idx) : undefined;
      const folderId = Array.isArray(rel) && typeof rel[0] === 'number' && folderIds[rel[0]] ? folderIds[rel[0]] : null;
      const item: CipherItem = {
        ...content,
        pk: `CIPHER#${user.id}#${id}`,
        sk: 'CIPHER',
        id,
        creationDate: now,
        revisionDate: now,
        folderId,
      };
      void ctx.store.putCipher(item);
    });
  }
  await Promise.all([]);
  return json(200, {});
}

// PUT|POST /api/ciphers/{id}/share — move a personal cipher into an org.
// Body (web vault): {collectionIds: [], collections: [{id, readOnly, hidePasswords}]}.
// Client re-wraps the cipher key and sends it back in body.cipher.key.
export async function cipherShare(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson;
  const collectionIds: string[] = Array.isArray(body.collectionIds)
    ? body.collectionIds.filter((s: unknown): s is string => typeof s === 'string')
    : [];
  if (collectionIds.length === 0) throw badBody('collectionIds is required.');
  const existing = await ctx.store.getCipher(ctx.user!.id, params.cipherId);
  if (!existing) throw notFoundErr();
  if (existing.organizationId) throw badBody('Cipher is already owned by an organization.');
  const col = (await ctx.store.listCollectionsForUser(ctx.user!.id)).find((c) => c.id === collectionIds[0]);
  if (!col) throw badBody('Collection not found.');
  const orgId = col.organizationId;
  const now = new Date().toISOString();
  const moved: CipherItem = {
    ...existing,
    pk: `CIPHER#${orgId}#${existing.id}`,
    organizationId: orgId,
    collectionIds,
    key: typeof body.cipher?.key === 'string' ? body.cipher.key : existing.key,
    folderId: null,
    revisionDate: now,
  };
  await ctx.store.deleteCipher(ctx.user!.id, existing.id);
  await ctx.store.putCipher(moved);
  await ctx.store.setOrgCipherCollections(orgId, existing.id, collectionIds);
  return json(200, {});
}

// PUT|POST /api/ciphers/{id}/admin — owner/admin bypass edit of an org cipher.
export async function cipherAdmin(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson;
  const memberships = await ctx.store.listOrganizationsForUser(ctx.user!.id);
  for (const m of memberships) {
    if (m.status < 2 || m.type > 1) continue;
    const item = await ctx.store.getOrgCipher(m.orgId, params.cipherId);
    if (!item) continue;
    await requireOrgAdmin(ctx, m.orgId);
    const collectionIds: string[] = Array.isArray(body.collectionIds)
      ? body.collectionIds.filter((s: unknown): s is string => typeof s === 'string')
      : item.collectionIds;
    const updated: CipherItem = {
      ...item,
      ...normalizeCreate(body),
      pk: item.pk,
      sk: 'CIPHER',
      id: item.id,
      organizationId: m.orgId,
      collectionIds,
      revisionDate: new Date().toISOString(),
    };
    await ctx.store.putCipher(updated);
    await ctx.store.setOrgCipherCollections(m.orgId, item.id, collectionIds);
    return json(200, await cipherJson(updated, 'cipher', ctx.objects));
  }
  throw notFoundErr();
}

// PUT|POST /api/ciphers/{id}/collections (+ _v2) — {collectionIds} membership update.
export async function cipherSetCollections(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson;
  const collectionIds: string[] = Array.isArray(body.collectionIds)
    ? body.collectionIds.filter((s: unknown): s is string => typeof s === 'string')
    : [];
  const { item, orgId, canWrite } = await resolveCipher(ctx, params.cipherId);
  if (!orgId) throw notFoundErr();
  if (!canWrite) throw new BitwardenError(403, 'Insufficient permissions to change collections.');
  await ctx.store.setOrgCipherCollections(orgId, item.id, collectionIds);
  return json(200, {});
}

// GET /api/ciphers/organization-details?organizationId= (+ /:organizationId alias)
// → org cipherDetails of collections the caller can access.
export async function cipherOrganizationDetails(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const orgId = String(ctx.query.organizationId ?? params.organizationId ?? '');
  if (orgId === '') throw badBody('organizationId is required.');
  const member = await ctx.store.getOrgUser(orgId, ctx.user!.id);
  if (!member || member.status < 2) throw notFoundErr();
  const accessible = member.type <= 1
    ? await ctx.store.listCollectionsForOrg(orgId)
    : (await ctx.store.listCollectionsForOrg(orgId)).filter(
        (col) => col.users.length === 0 || col.users.some((u) => u.id === ctx.user!.id),
      );
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const col of accessible) {
    for (const cipherId of await ctx.store.listCollectionCipherIds(orgId, col.id)) {
      if (seen.has(cipherId)) continue;
      seen.add(cipherId);
      const item = await ctx.store.getOrgCipher(orgId, cipherId);
      if (item && item.deletedDate === null) {
        out.push(await cipherJson(item, 'cipherDetails', ctx.objects));
      }
    }
  }
  return json(200, out);
}

export { cipherJson, sizeName };