import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { CipherItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function notFoundErr() {
  return new BitwardenError(404, 'Not found.');
}

// Canonical serializer (pitfall 1.5: type payload strictly separated, never
// folded; explicit nulls — pitfall 2.5). Encrypted strings relayed verbatim.
function cipherJson(item: CipherItem, object: 'cipher' | 'cipherDetails') {
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
    attachments: null,
    organizationUseTotp: true,
    collectionIds: [],
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
  };
}

// GET /api/ciphers — non-deleted only
export async function cipherList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const all = await ctx.store.listCiphers(ctx.user!.id);
  const data = all.filter((c) => c.deletedDate === null).map((c) => cipherJson(c, 'cipherDetails'));
  return json(200, { object: 'list', data, continuationToken: null });
}

// GET /api/ciphers/{id} and /api/ciphers/{id}/details
export async function cipherGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const item = await ctx.store.getCipher(ctx.user!.id, params.cipherId);
  if (!item) throw notFoundErr();
  return json(200, cipherJson(item, 'cipherDetails'));
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
  return json(200, cipherJson(item, 'cipher'));
}

// PUT|POST /api/ciphers/{id} — full replace
export async function cipherUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const existing = await ctx.store.getCipher(ctx.user!.id, params.cipherId);
  if (!existing) throw notFoundErr();
  const item: CipherItem = {
    ...existing,
    ...normalizeCreate(ctx.bodyJson),
    pk: existing.pk,
    sk: 'CIPHER',
    id: existing.id,
    creationDate: existing.creationDate,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCipher(item);
  return json(200, cipherJson(item, 'cipher'));
}

// PUT|POST /api/ciphers/{id}/partial — merge login fields only (extension autofill)
export async function cipherPartial(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const existing = await ctx.store.getCipher(ctx.user!.id, params.cipherId);
  if (!existing) throw notFoundErr();
  const login = ctx.bodyJson.login;
  const newLogin = {
    username: login?.username !== undefined ? str(login?.username) : (existing.login?.username ?? null),
    password: login?.password !== undefined ? str(login?.password) : (existing.login?.password ?? null),
    uris: Array.isArray(login?.uris)
      ? login.uris.map((u: any) => ({
          uri: str(u.uri),
          match: u.match === null || u.match === undefined ? null : Number(u.match),
        }))
      : (existing.login?.uris ?? null),
    totp: login?.totp !== undefined ? str(login?.totp) : (existing.login?.totp ?? null),
    passwordRevisionDate:
      login?.passwordRevisionDate !== undefined
        ? str(login?.passwordRevisionDate)
        : (existing.login?.passwordRevisionDate ?? null),
    fido2Credentials: login?.fido2Credentials ?? existing.login?.fido2Credentials ?? null,
  };
  const updated: CipherItem = {
    ...existing,
    login: newLogin,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putCipher(updated);
  return json(200, cipherJson(updated, 'cipher'));
}

// DELETE|POST|PUT /api/ciphers/{id} (+ /delete) — soft delete
async function softDelete(ctx: RouteContext, cipherId: string): Promise<unknown> {
  const existing = await ctx.store.getCipher(ctx.user!.id, cipherId);
  if (!existing) throw notFoundErr();
  await ctx.store.putCipher({
    ...existing,
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
  const existing = await ctx.store.getCipher(ctx.user!.id, params.cipherId);
  if (!existing) throw notFoundErr();
  await ctx.store.putCipher({
    ...existing,
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
    const existing = await ctx.store.getCipher(ctx.user!.id, id);
    if (!existing) continue;
    await ctx.store.putCipher({ ...existing, folderId: folder, revisionDate: new Date().toISOString() });
  }
  return json(200, {});
}

// POST /api/ciphers/purge — permanent delete of trash rows
export async function cipherPurge(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const ids: unknown[] = ctx.bodyJson.ids ?? [];
  for (const id of ids) {
    if (typeof id === 'string') await ctx.store.deleteCipher(ctx.user!.id, id);
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

export { cipherJson };