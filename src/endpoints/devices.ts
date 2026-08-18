import { notFound } from '../errors';
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