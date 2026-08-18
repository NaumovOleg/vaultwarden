import { newUuid } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { FolderItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function folderJson(item: FolderItem) {
  return { id: item.id, name: item.name, revisionDate: item.revisionDate, object: 'folder' };
}

// GET /api/folders
export async function folderList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const folders = await ctx.store.listFolders(ctx.user!.id);
  return json(200, { object: 'list', data: folders.map(folderJson), continuationToken: null });
}

// GET /api/folders/{id}
export async function folderGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const folder = await ctx.store.getFolder(ctx.user!.id, params.folderId);
  if (!folder) throw new BitwardenError(404, 'Not found.');
  return json(200, folderJson(folder));
}

// POST /api/folders — {name}
export async function folderCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const name = typeof ctx.bodyJson.name === 'string' ? ctx.bodyJson.name : '';
  const id = newUuid();
  const item: FolderItem = {
    pk: `FOLDER#${ctx.user!.id}#${id}`,
    sk: 'FOLDER',
    id,
    name,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putFolder(item);
  return json(200, folderJson(item));
}

// PUT|POST /api/folders/{id} — {name}
export async function folderUpdate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const existing = await ctx.store.getFolder(ctx.user!.id, params.folderId);
  if (!existing) throw new BitwardenError(404, 'Not found.');
  const updated: FolderItem = {
    ...existing,
    name: typeof ctx.bodyJson.name === 'string' ? ctx.bodyJson.name : existing.name,
    revisionDate: new Date().toISOString(),
  };
  await ctx.store.putFolder(updated);
  return json(200, folderJson(updated));
}

// DELETE|POST|PUT /api/folders/{id} (+ /delete) — hard delete; member ciphers
// orphaned (folderId → null), matching vaultwarden's FolderCipher join deletion.
export async function folderDelete(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const existing = await ctx.store.getFolder(user.id, params.folderId);
  if (!existing) throw new BitwardenError(404, 'Not found.');
  await ctx.store.deleteFolder(user.id, params.folderId);
  for (const cipher of await ctx.store.listCiphers(user.id)) {
    if (cipher.folderId === params.folderId) {
      await ctx.store.putCipher({ ...cipher, folderId: null, revisionDate: new Date().toISOString() });
    }
  }
  return json(200, {});
}