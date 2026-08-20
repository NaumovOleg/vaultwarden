import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { deviceList, deviceCreate, deviceById, deviceRegisterToken, deviceClearToken, knownDevice } from '../src/endpoints/devices';

const routes: Route[] = [
  { method: 'GET', pattern: '/api/devices', handler: deviceList, auth: true },
  { method: 'POST', pattern: '/api/devices', handler: deviceCreate, auth: true },
  { method: 'GET', pattern: '/api/devices/knowndevice', handler: knownDevice },
  { method: 'GET', pattern: '/api/devices/identifier/:deviceId', handler: deviceById, auth: true },
  { method: 'PUT', pattern: '/api/devices/identifier/:deviceId/token', handler: deviceRegisterToken, auth: true },
  { method: 'POST', pattern: '/api/devices/identifier/:deviceId/token', handler: deviceRegisterToken, auth: true },
  { method: 'PUT', pattern: '/api/devices/identifier/:deviceId/clear-token', handler: deviceClearToken, auth: true },
  { method: 'POST', pattern: '/api/devices/identifier/:deviceId/clear-token', handler: deviceClearToken, auth: true },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/endsession', handler: (p, ctx) => endsession(p, ctx) },
];

import { token, register, endsession } from '../src/endpoints/identity';
import { newUuid } from '../src/crypto';
import type { UserItem } from '../src/store';

const PASSWORD = Buffer.from('client-hash').toString('base64');

function makeEnv() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function ev(method: string, rawPath: string, body = '', token?: string, contentType?: string, extraHeaders?: Record<string, string>): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = contentType ?? 'application/json';
  Object.assign(headers, extraHeaders);
  return {
    rawPath,
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function seedUserAndToken(env: ReturnType<typeof makeEnv>, email: string) {
  await env.handler(
    ev('POST', '/identity/accounts/register', JSON.stringify({ email, masterPasswordAuthentication: { hash: PASSWORD } })),
  );
  const login = await env.handler(
    ev(
      'POST',
      '/identity/connect/token',
      new URLSearchParams({
        grant_type: 'password',
        username: email,
        password: PASSWORD,
        scope: 'api offline_access',
        deviceIdentifier: 'dev-seed',
        deviceName: 'Seed Device',
        deviceType: '9',
      }).toString(),
      undefined,
      'application/x-www-form-urlencoded',
    ),
  );
  const body = JSON.parse(login.body as string);
  return { accessToken: body.access_token as string, refreshToken: body.refresh_token as string };
}

function bareUser(email: string): UserItem {
  return {
    pk: `USER#${email}`,
    sk: 'PROFILE',
    id: email,
    email,
    passwordHash: 'x',
    salt: 'x',
    passwordIterations: 600_000,
    kdfType: 0,
    kdfIterations: 600_000,
    kdfMemory: null,
    kdfParallelism: null,
    securityStamp: newUuid(),
    akey: 'k',
    privateKey: null,
    publicKey: null,
    name: email,
    masterPasswordHint: null,
    enabled: true,
    premium: true,
    twoFactorEnabled: false,
    totpSecret: null,
    totpPendingSecret: null,
    email2faEnabled: false,
    email2faAddress: null,
    domainsOverride: null,
    avatarColor: '#607D8B',
    masterKeyEncryptedUserKey: null,
    masterKeyWrappedUserKey: null,
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
    createdAt: new Date().toISOString(),
  };
}

describe('devices endpoints', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('lists devices created at login with the exact list shape', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'list@example.com');
    const r = await env.handler(ev('GET', '/api/devices', '', accessToken));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.object).toBe('list');
    expect(body.continuationToken).toBeNull();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: 'dev-seed',
      name: 'Seed Device',
      type: 9,
      identifier: 'dev-seed',
      creationDate: expect.any(String),
      lastUsedDate: expect.any(String),
      object: 'device',
    });
  });

  it('creates a device via POST /api/devices (idempotent, trailing slash ok)', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'create@example.com');
    const body = JSON.stringify({ deviceIdentifier: 'new-dev', name: 'New Dev', deviceType: 9 });
    const r1 = await env.handler(ev('POST', '/api/devices', body, accessToken));
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body as string)).toMatchObject({ id: 'new-dev', name: 'New Dev', type: 9, object: 'device' });
    // idempotent upsert: same id, same row
    const r2 = await env.handler(ev('POST', '/api/devices/', body, accessToken));
    expect(r2.statusCode).toBe(200);
    const listed = await env.handler(ev('GET', '/api/devices', '', accessToken));
    expect(JSON.parse(listed.body as string).data).toHaveLength(2);
    // missing identifier → 400
    const r3 = await env.handler(ev('POST', '/api/devices', '{}', accessToken));
    expect(r3.statusCode).toBe(400);
  });

  it('gets a device by identifier; unknown → 404 envelope', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'byid@example.com');
    const r = await env.handler(ev('GET', '/api/devices/identifier/dev-seed', '', accessToken));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string).identifier).toBe('dev-seed');

    const missing = await env.handler(ev('GET', '/api/devices/identifier/nope', '', accessToken));
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body as string).Message).toBe('Not found.');
  });

  it('registers and clears a push token (both methods)', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'push@example.com');
    const userId = (await env.store.getUserByEmail('push@example.com'))!.id;

    const put = await env.handler(
      ev('PUT', '/api/devices/identifier/dev-seed/token', JSON.stringify({ pushToken: 'tok-123' }), accessToken),
    );
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body as string)).toEqual({});
    expect((await env.store.getDevice(userId, 'dev-seed'))!.pushToken).toBe('tok-123');

    const post = await env.handler(
      ev('POST', '/api/devices/identifier/dev-seed/clear-token', JSON.stringify({}), accessToken),
    );
    expect(post.statusCode).toBe(200);
    expect((await env.store.getDevice(userId, 'dev-seed'))!.pushToken).toBeNull();
  });

  it('token/clear-token on an unknown device → 404', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'ghost@example.com');
    const r = await env.handler(
      ev('PUT', '/api/devices/identifier/ghost-device/token', JSON.stringify({ pushToken: 'x' }), accessToken),
    );
    expect(r.statusCode).toBe(404);
  });

  it('devices are scoped per user', async () => {
    const env = makeEnv();
    const a = await seedUserAndToken(env, 'alice@example.com');
    await seedUserAndToken(env, 'bob@example.com');
    const r = await env.handler(ev('GET', '/api/devices', '', a.accessToken));
    const body = JSON.parse(r.body as string);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].identifier).toBe('dev-seed');
  });

  it('missing or invalid bearer → exact 401 envelope', async () => {
    const env = makeEnv();
    await seedUserAndToken(env, 'auth@example.com');

    const noToken = await env.handler(ev('GET', '/api/devices'));
    expect(noToken.statusCode).toBe(401);
    expect(JSON.parse(noToken.body as string)).toEqual({ Message: 'Unauthorized' });

    const badToken = await env.handler(ev('GET', '/api/devices', '', 'garbage'));
    expect(badToken.statusCode).toBe(401);
    expect(JSON.parse(badToken.body as string)).toEqual({ Message: 'Unauthorized' });
  });

  it('a revoked access token 401s', async () => {
    const env = makeEnv();
    const { accessToken, refreshToken } = await seedUserAndToken(env, 'revoke@example.com');
    await env.handler(
      ev(
        'POST',
        '/identity/connect/endsession',
        new URLSearchParams({ refresh_token: refreshToken }).toString(),
        undefined,
        'application/x-www-form-urlencoded',
      ),
    );
    const r = await env.handler(ev('GET', '/api/devices', '', accessToken));
    expect(r.statusCode).toBe(401);
  });

  it('stamp change revokes access tokens', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'stamp@example.com');
    const user = (await env.store.getUserByEmail('stamp@example.com'))!;
    await env.store.putUser({ ...user, securityStamp: newUuid() });
    const r = await env.handler(ev('GET', '/api/devices', '', accessToken));
    expect(r.statusCode).toBe(401);
  });

  it('devices list reflects only the user sessions from the store', async () => {
    const env = makeEnv();
    const { accessToken } = await seedUserAndToken(env, 'bare@example.com');
    await env.store.putUser(bareUser('bare-other@example.com'));
    await env.store.upsertDevice({
      pk: 'USER#bare-other@example.com',
      sk: 'DEV#other-dev',
      name: 'Other',
      type: 3,
      pushToken: null,
      creationDate: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      twoFactorRemembered: false,
    });
    const r = await env.handler(ev('GET', '/api/devices', '', accessToken));
    expect(JSON.parse(r.body as string).data).toHaveLength(1);
  });

  it('knowndevice probe: unauthenticated, base64url email header, raw boolean', async () => {
    const env = makeEnv();
    await seedUserAndToken(env, 'known@example.com');
    const email64 = Buffer.from('known@example.com').toString('base64url');

    const headers = (email64: string, deviceId: string) => ({
      'x-request-email': email64,
      'x-device-identifier': deviceId,
    });

    const known = await env.handler(ev('GET', '/api/devices/knowndevice', '', undefined, undefined, headers(email64, 'dev-seed')));
    expect(known.statusCode).toBe(200);
    expect(JSON.parse(known.body as string)).toBe(true);

    const otherDevice = await env.handler(ev('GET', '/api/devices/knowndevice', '', undefined, undefined, headers(email64, 'other-dev')));
    expect(JSON.parse(otherDevice.body as string)).toBe(false);

    const unknownEmail = await env.handler(ev('GET', '/api/devices/knowndevice', '', undefined, undefined, headers(Buffer.from('nobody@example.com').toString('base64url'), 'dev-seed')));
    expect(JSON.parse(unknownEmail.body as string)).toBe(false);

    const noHeaders = await env.handler(ev('GET', '/api/devices/knowndevice'));
    expect(noHeaders.statusCode).toBe(200);
    expect(JSON.parse(noHeaders.body as string)).toBe(false);
  });
});