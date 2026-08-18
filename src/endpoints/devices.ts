import { badRequest, notFound } from '../errors';
import type { RouteContext } from '../router';
import type { DeviceItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function deviceJson(device: DeviceItem, userId: string) {
  return {
    id: device.sk.slice('DEV#'.length),
    name: device.name,
    type: device.type,
    identifier: device.sk.slice('DEV#'.length),
    creationDate: device.creationDate,
    lastUsedDate: device.lastUsed,
    object: 'device',
  };
}

// GET /api/devices
export async function deviceList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const devices = await ctx.store.listDevices(ctx.user!.id);
  return json(200, {
    object: 'list',
    data: devices.map((d) => deviceJson(d, ctx.user!.id)),
    continuationToken: null,
  });
}

// POST /api/devices — client-registered device (autofill extension, some
// mobile flows). Idempotent upsert keyed by deviceIdentifier.
export async function deviceCreate(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const deviceId = String(ctx.bodyJson.deviceIdentifier ?? ctx.bodyForm.get('deviceIdentifier') ?? '');
  if (!deviceId) throw badRequest('deviceIdentifier is required.');
  const now = new Date().toISOString();
  const existing = await ctx.store.getDevice(ctx.user!.id, deviceId);
  const device: DeviceItem = {
    pk: `USER#${ctx.user!.id}`,
    sk: `DEV#${deviceId}`,
    name: String(ctx.bodyJson.name ?? ctx.bodyForm.get('name') ?? null),
    type: Number(ctx.bodyJson.deviceType ?? ctx.bodyForm.get('deviceType') ?? existing?.type ?? 0),
    pushToken: String(ctx.bodyJson.pushToken ?? ctx.bodyForm.get('pushToken') ?? existing?.pushToken ?? null),
    creationDate: existing?.creationDate ?? now,
    lastUsed: now,
    twoFactorRemembered: existing?.twoFactorRemembered ?? false,
  };
  await ctx.store.upsertDevice(device);
  return json(200, deviceJson(device, ctx.user!.id));
}

// GET /api/devices/identifier/{deviceId}
export async function deviceById(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const device = await ctx.store.getDevice(ctx.user!.id, params.deviceId);
  if (!device) throw notFound();
  return json(200, deviceJson(device, ctx.user!.id));
}

// PUT|POST /api/devices/identifier/{deviceId}/token
export async function deviceRegisterToken(
  params: Record<string, string>,
  ctx: RouteContext,
): Promise<unknown> {
  const device = await ctx.store.getDevice(ctx.user!.id, params.deviceId);
  if (!device) throw notFound();
  const pushToken = (ctx.bodyJson.pushToken ?? ctx.bodyForm.get('pushToken') ?? null) as string | null;
  await ctx.store.upsertDevice({ ...device, pushToken });
  return json(200, {});
}

// PUT|POST /api/devices/identifier/{deviceId}/clear-token
export async function deviceClearToken(
  params: Record<string, string>,
  ctx: RouteContext,
): Promise<unknown> {
  const device = await ctx.store.getDevice(ctx.user!.id, params.deviceId);
  if (!device) throw notFound();
  await ctx.store.upsertDevice({ ...device, pushToken: null });
  return json(200, {});
}