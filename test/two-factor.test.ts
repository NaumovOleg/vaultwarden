import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { totpCode } from '../src/crypto';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { register, token } from '../src/endpoints/identity';
import { twoFactorList, getAuthenticator, authenticatorEnable, authenticatorDisable, getRecoveryCodes } from '../src/endpoints/two-factor';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'GET', pattern: '/api/two-factor', handler: (p, ctx) => twoFactorList(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/two-factor/get-authenticator', handler: (p, ctx) => getAuthenticator(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/two-factor/authenticator', handler: (p, ctx) => authenticatorEnable(p, ctx), auth: true },
  { method: 'PUT', pattern: '/api/two-factor/authenticator', handler: (p, ctx) => authenticatorEnable(p, ctx), auth: true },
  { method: 'DELETE', pattern: '/api/two-factor/authenticator', handler: (p, ctx) => authenticatorDisable(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/two-factor/get-recover', handler: (p, ctx) => getRecoveryCodes(p, ctx), auth: true },
];

const PASSWORD = Buffer.from('the-client-side-hash').toString('base64');

function makeHandler() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function apiEvent(method: string, rawPath: string, body: unknown, token?: string): APIGatewayProxyEventV2 {
  return {
    rawPath,
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

function formEvent(parts: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    rawPath: '/identity/connect/token',
    body: new URLSearchParams(parts).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { http: { method: 'POST' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function registerUser(handler: (e: APIGatewayProxyEventV2) => Promise<any>) {
  const r = await handler({
    rawPath: '/identity/accounts/register',
    body: JSON.stringify({
      email: 'tfa@example.com',
      masterPasswordAuthentication: { hash: PASSWORD },
      key: 'akey-value',
      keys: { publicKey: 'pub', privateKey: 'priv' },
    }),
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2);
  expect(r.statusCode).toBe(200);
}

function login(overrides: Record<string, string> = {}) {
  return formEvent({
    grant_type: 'password',
    username: 'tfa@example.com',
    password: PASSWORD,
    scope: 'api offline_access',
    client_id: 'web',
    deviceType: '9',
    deviceIdentifier: 'dev-1',
    deviceName: 'Test Browser',
    ...overrides,
  });
}

async function accessToken(handler: (e: APIGatewayProxyEventV2) => Promise<any>, overrides: Record<string, string> = {}) {
  const r = await handler(login(overrides));
  expect(r.statusCode).toBe(200);
  return (JSON.parse(r.body as string) as { access_token: string }).access_token;
}

describe('two-factor endpoints + login challenge', () => {
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });

  it('enables TOTP via get-authenticator + authenticator, then challenges login', async () => {
    const { store, handler } = makeHandler();
    await registerUser(handler);
    const tok = await accessToken(handler);

    const got = await handler(apiEvent('POST', '/api/two-factor/get-authenticator', { masterPasswordHash: PASSWORD }, tok));
    expect(got.statusCode).toBe(200);
    const { key } = JSON.parse(got.body as string);
    expect(key).toMatch(/^[A-Z2-7]{52}$/);

    const bad = await handler(
      apiEvent('POST', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD, key, token: '000000' }, tok),
    );
    expect(bad.statusCode).toBe(400);

    const good = await handler(
      apiEvent('POST', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD, key, token: totpCode(key) }, tok),
    );
    expect(good.statusCode).toBe(200);
    const user = await store.getUserByEmail('tfa@example.com');
    expect(user!.totpSecret).toBe(key);
    expect(user!.twoFactorEnabled).toBe(true);

    const list = await handler(apiEvent('GET', '/api/two-factor', {}, tok));
    const data = JSON.parse(list.body as string).Data as { Object: string; Enabled: boolean }[];
    expect(data.find((d) => d.Object === 'twoFactorAuthenticator')!.Enabled).toBe(true);

    const challenge = await handler(login());
    expect(challenge.statusCode).toBe(200);
    const body = JSON.parse(challenge.body as string);
    expect(body.TwoFactorProviders).toEqual([0]);
    expect(body.TwoFactorProviders2['0'].Enabled).toBe(true);
    expect(typeof body.TwoFactorToken).toBe('string');

    const wrong = await handler(login({ twoFactorToken: body.TwoFactorToken, twoFactorProvider: '0', twoFactorCode: '000000' }));
    expect(wrong.statusCode).toBe(400);

    const challenge2 = await handler(login());
    const tfaToken2 = JSON.parse(challenge2.body as string).TwoFactorToken;
    const ok = await handler(
      login({ twoFactorToken: tfaToken2, twoFactorProvider: '0', twoFactorCode: totpCode(key) }),
    );
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body as string).access_token).toBeDefined();
  });

  it('login accepts a recovery code', async () => {
    const { handler } = makeHandler();
    await registerUser(handler);
    const tok = await accessToken(handler);
    const got = await handler(apiEvent('POST', '/api/two-factor/get-authenticator', { masterPasswordHash: PASSWORD }, tok));
    const key = JSON.parse(got.body as string).key;
    await handler(apiEvent('POST', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD, key, token: totpCode(key) }, tok));

    const rec = await handler(apiEvent('POST', '/api/two-factor/get-recover', { masterPasswordHash: PASSWORD }, tok));
    const codes = JSON.parse(rec.body as string).codes as string[];
    expect(codes).toHaveLength(5);

    const challenge = await handler(login());
    const tfaToken = JSON.parse(challenge.body as string).TwoFactorToken;
    const ok = await handler(
      login({ twoFactorToken: tfaToken, twoFactorProvider: '0', twoFactorCode: codes[0] }),
    );
    expect(ok.statusCode).toBe(200);
  });

  it('remembered device skips the challenge on later logins', async () => {
    const { store, handler } = makeHandler();
    await registerUser(handler);
    const tok = await accessToken(handler);
    const got = await handler(apiEvent('POST', '/api/two-factor/get-authenticator', { masterPasswordHash: PASSWORD }, tok));
    const key = JSON.parse(got.body as string).key;
    await handler(apiEvent('POST', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD, key, token: totpCode(key) }, tok));

    const challenge = await handler(login());
    const tfaToken = JSON.parse(challenge.body as string).TwoFactorToken;
    const ok = await handler(
      login({
        twoFactorToken: tfaToken,
        twoFactorProvider: '0',
        twoFactorCode: totpCode(key),
        twoFactorRemember: '1',
      }),
    );
    expect(ok.statusCode).toBe(200);
    const user = await store.getUserByEmail('tfa@example.com');
    const device = await store.getDevice(user!.id, 'dev-1');
    expect(device!.twoFactorRemembered).toBe(true);

    const second = await handler(login());
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body as string).access_token).toBeDefined();
  });

  it('disable requires the password and re-enables plain login', async () => {
    const { handler } = makeHandler();
    await registerUser(handler);
    const tok = await accessToken(handler);
    const got = await handler(apiEvent('POST', '/api/two-factor/get-authenticator', { masterPasswordHash: PASSWORD }, tok));
    const key = JSON.parse(got.body as string).key;
    await handler(apiEvent('POST', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD, key, token: totpCode(key) }, tok));

    const noPass = await handler(apiEvent('DELETE', '/api/two-factor/authenticator', {}, tok));
    expect(noPass.statusCode).toBe(400);

    const dis = await handler(apiEvent('DELETE', '/api/two-factor/authenticator', { masterPasswordHash: PASSWORD }, tok));
    expect(dis.statusCode).toBe(200);

    const plain = await handler(login());
    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body as string).access_token).toBeDefined();
  });
});
