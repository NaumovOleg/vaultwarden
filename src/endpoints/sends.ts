import { createHash } from 'crypto';
import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { SendItem } from '../store';
import { parseBodyBytes } from './multipart';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function notFoundErr() {
  return new BitwardenError(404, 'Not found.');
}

function badBody(message: string): BitwardenError {
  return new BitwardenError(400, message);
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

// 10-char hex access handle, derived from a uuid (vaultwarden accessId).
function accessId(): string {
  return newUuid().replace(/-/g, '').slice(0, 10);
}

// Client hashes the send password (SHA-256 base64); server stores + compares verbatim.
function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('base64');
}

// Canonical send JSON. File url is omitted here — anonymous access exposes
// the download handle instead of a presigned url.
export function sendJson(send: SendItem): Record<string, unknown> {
  return {
    id: send.id,
    accessId: send.accessId,
    name: send.name,
    notes: send.notes,
    type: send.type,
    file: send.file,
    text: send.text,
    maxAccessCount: send.maxAccessCount,
    accessCount: send.accessCount,
    expirationDate: send.expirationDate,
    deletionDate: send.deletionDate,
    passwordProtected: send.passwordHash !== null,
    disabled: send.disabled,
    hideEmail: send.hideEmail,
    revisionDate: send.revisionDate,
    object: 'send',
  };
}

function visible(send: SendItem, now: string): boolean {
  return !send.disabled && (send.deletionDate === null || send.deletionDate > now);
}

function fromBody(body: Record<string, any>, existing: SendItem | null): SendItem {
  const now = new Date().toISOString();
  const str = (k: string): string | null => (typeof body[k] === 'string' ? body[k] : null);
  const num = (k: string): number | null => (typeof body[k] === 'number' ? body[k] : null);
  const bool = (k: string): boolean => (typeof body[k] === 'boolean' ? body[k] : false);
  const rawText = body.text as Record<string, unknown> | undefined;
  return {
    pk: existing?.pk ?? '',
    sk: 'SEND',
    id: str('id') ?? existing?.id ?? '',
    accessId: existing?.accessId ?? accessId(),
    type: existing?.type ?? (rawText ? 0 : 1),
    name: str('name') ?? existing?.name ?? '',
    notes: str('notes') ?? existing?.notes ?? null,
    text:
      rawText && typeof rawText.text === 'string'
        ? { text: rawText.text, hidden: rawText.hidden === true }
        : existing?.text ?? null,
    file: existing?.file ?? null,
    passwordHash: str('password') !== null ? hashPassword(str('password')!) : existing?.passwordHash ?? null,
    maxAccessCount: num('maxAccessCount') ?? existing?.maxAccessCount ?? null,
    accessCount: existing?.accessCount ?? 0,
    expirationDate: str('expirationDate') ?? existing?.expirationDate ?? null,
    deletionDate: str('deletionDate') ?? existing?.deletionDate ?? null,
    disabled: bool('disabled') || (existing?.disabled ?? false),
    hideEmail: bool('hideEmail') || (existing?.hideEmail ?? false),
    revisionDate: now,
  };
}

async function sendJsonOr404(store: { getSend(userId: string, sendId: string): Promise<SendItem | null> }, userId: string, sendId: string) {
  const send = await store.getSend(userId, sendId);
  if (!send) throw notFoundErr();
  return send;
}

// GET /api/sends — visible sends only (deletionDate-past / disabled are dropped lazily).
export async function sendList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const sends = await ctx.store.listSends(ctx.user!.id);
  const now = new Date().toISOString();
  return json(200, sends.filter((s) => visible(s, now)).map(sendJson));
}

// GET /api/sends/{id}
export async function sendGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const send = await sendJsonOr404(ctx.store, ctx.user!.id, params.id);
  return json(200, sendJson(send));
}

// POST /api/sends — {type:0, name, text:{text,hidden}, password?, maxAccessCount?, ...}
export async function sendCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const item = fromBody(ctx.bodyJson, null);
  item.pk = `SEND#${user.id}#${item.id}`;
  if (item.id === '' || item.name === '') throw badBody('Missing id or name.');
  if (item.file === null && item.text === null) throw badBody('A send needs text or file content.');
  await ctx.store.putSend(item);
  return json(200, sendJson(item));
}

// PUT /api/sends/{id}
export async function sendUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const existing = await sendJsonOr404(ctx.store, user.id, params.id);
  const item = fromBody(ctx.bodyJson, existing);
  item.pk = existing.pk;
  item.id = existing.id;
  item.accessId = existing.accessId;
  item.accessCount = existing.accessCount;
  await ctx.store.putSend(item);
  return json(200, sendJson(item));
}

// DELETE /api/sends/{id} + POST /api/sends/{id}/delete — cascades file objects.
export async function sendDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const send = await sendJsonOr404(ctx.store, user.id, params.id);
  if (send.type === 1) await ctx.objects.deletePrefix(`sends/${send.id}/`);
  await ctx.store.deleteSend(user.id, send.id);
  return json(200, {});
}

// PUT /api/sends/{id}/remove-password
export async function sendRemovePassword(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const existing = await sendJsonOr404(ctx.store, user.id, params.id);
  await ctx.store.putSend({ ...existing, passwordHash: null, revisionDate: new Date().toISOString() });
  return json(200, {});
}

const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

// POST /api/sends/file/v2 — {key, fileName, fileSize} → {object:'send-fileUpload', ...}
export async function sendFileV2(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson;
  const fileName = typeof body.fileName === 'string' ? body.fileName : '';
  const key = typeof body.key === 'string' ? body.key : '';
  if (fileName === '' || key === '') throw badBody('Missing fileName or key.');
  const id = newUuid();
  const fileId = newUuid();
  const size = typeof body.fileSize === 'number' ? body.fileSize : 0;
  const item: SendItem = {
    pk: `SEND#${user.id}#${id}`,
    sk: 'SEND',
    id,
    accessId: accessId(),
    type: 1,
    name: '',
    notes: null,
    text: null,
    file: { id: fileId, fileName, size, sizeName: sizeName(size), key },
    passwordHash: null,
    maxAccessCount: null,
    accessCount: 0,
    expirationDate: null,
    deletionDate: null,
    disabled: false,
    hideEmail: false,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putSend(item);
  return json(200, {
    object: 'send-fileUpload',
    fileUploadType: 0,
    url: `/api/sends/${id}/file/${fileId}`,
    sendResponse: sendJson(item),
  });
}

// POST /api/sends/{id}/file/{fileId} — multipart {key, data}
export async function sendFileUpload(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const send = await sendJsonOr404(ctx.store, user.id, params.id);
  if (send.type !== 1 || !send.file || send.file.id !== params.fileId) throw notFoundErr();
  const fields = parseBodyBytes(ctx.headers['content-type'] ?? '', ctx.bodyBytes);
  const data = fields.get('data');
  if (!data) throw badBody('Missing data field.');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new BitwardenError(413, 'Send file exceeds the 4.5 MB limit.');
  }
  await ctx.objects.putObject(`sends/${send.id}/${send.file.id}`, data);
  const updated: SendItem = { ...send, file: { ...send.file, size: data.length, sizeName: sizeName(data.length) } };
  await ctx.store.putSend(updated);
  return json(200, sendJson(updated));
}

// Anonymous access. POST /api/sends/access/{accessId} {password?}
export async function sendAccess(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson;
  const provided = typeof body.password === 'string' ? body.password : null;
  const found = await ctx.store.findSendByAccessId(params.accessId);
  const now = new Date().toISOString();
  if (!found || !visible(found, now)) throw notFoundErr();
  if (found.expirationDate !== null && found.expirationDate <= now) throw notFoundErr();
  if (found.passwordHash !== null) {
    if (provided === null || hashPassword(provided) !== found.passwordHash) {
      throw new BitwardenError(400, 'Password required.', { passwordRequired: ['Password required.'] });
    }
  }
  if (found.maxAccessCount !== null && found.accessCount >= found.maxAccessCount) {
    throw new BitwardenError(400, 'Maximum access count reached.');
  }
  const updated = { ...found, accessCount: found.accessCount + 1, revisionDate: new Date().toISOString() };
  await ctx.store.putSend(updated);
  return json(200, {
    id: found.id,
    accessId: found.accessId,
    name: found.name,
    type: found.type,
    data: found.type === 1 ? { file: found.file } : { text: found.text },
    expirationDate: found.expirationDate,
    passwordProtected: found.passwordHash !== null,
    hideEmail: found.hideEmail,
    object: 'sendAccess',
  });
}

// Anonymous file download. GET /api/sends/{accessId}/file/{fileId}?t= — 302 to presigned GET.
export async function sendFileDownload(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const now = new Date().toISOString();
  const found = await ctx.store.findSendByAccessId(params.accessId);
  if (!found || !visible(found, now) || found.type !== 1 || !found.file || found.file.id !== params.fileId) {
    throw notFoundErr();
  }
  if (found.expirationDate !== null && found.expirationDate <= now) throw notFoundErr();
  const url = await ctx.objects.presignedGetUrl(`sends/${found.id}/${found.file.id}`);
  return {
    statusCode: 302,
    headers: { Location: url, 'Cache-Control': 'private, max-age=60' },
    body: '',
  };
}
