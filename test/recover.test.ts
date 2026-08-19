import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import type { Mailer } from '../src/ses';
import { MemoryStore } from '../src/store';
import { register, token, prelogin, recoverPassword, recoverTwoFactor } from '../src/endpoints/identity';
import { recoverReset } from '../src/endpoints/accounts';
import { cipherList, cipherCreate } from '../src/endpoints/ciphers';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/prelogin', handler: (p, ctx) => prelogin(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/recover', handler: (p, ctx) => recoverPassword(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/recover/two-factor', handler: (p, ctx) => recoverTwoFactor(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/recover/reset', handler: (p, ctx) => recoverReset(p, ctx) },
  { method: 'GET', pattern: '/api/ciphers', handler: (p, c) => cipherList(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers', handler: (p, c) => cipherCreate(p, c), auth: true },
];

const PASSWORD = Buffer.from('client-hash').toString('base64');
const NEW_PASSWORD = Buffer.from('new-client-hash').toString('base64');
const EMAIL = 'recover@test.dev';

function makeEnv() {
  process.env.SIGNUPS_ALLOWED = 'true';
  const send = jest.fn<Promise<void>, [string, string, string]>();
  const mailer: Mailer = { send };
  const store = new MemoryStore();
  return { store, send, handler: createHandler(routes, { store, mailer }) };
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
  const r = await handler(
    apiEvent('POST', '/identity/accounts/register', {
      email: EMAIL,
      masterPasswordAuthentication: { hash: PASSWORD },
      key: 'akey',
      keys: { publicKey: 'pub', privateKey: 'priv' },
    }),
  );
  expect(r.statusCode).toBe(200);
}

async function accessToken(handler: (e: APIGatewayProxyEventV2) => Promise<any>, password = PASSWORD) {
  const r = await handler(
    formEvent({
      grant_type: 'password',
      username: EMAIL,
      password,
      scope: 'api offline_access',
      deviceIdentifier: 'dev-1',
      deviceType: '9',
    }),
  );
  return r;
}

function lastRecoveryCode(env: ReturnType<typeof makeEnv>): string {
  const body = env.send.mock.calls[env.send.mock.calls.length - 1][2];
  const m = /recovery code is (\d{8})/.exec(body);
  expect(m).not.toBeNull();
  return m![1];
}

describe('account recovery', () => {
  it('emails a code, 429 on spam, silent 200 for unknown email', async () => {
    const env = makeEnv();
    await registerUser(env.handler);

    const first = await env.handler(apiEvent('POST', '/identity/accounts/recover', { email: EMAIL }));
    expect(first.statusCode).toBe(200);
    expect(env.send).toHaveBeenCalledTimes(1);
    expect(env.send.mock.calls[0][0]).toBe(EMAIL);
    expect(lastRecoveryCode(env)).toMatch(/^\d{8}$/);

    const again = await env.handler(apiEvent('POST', '/identity/accounts/recover', { email: EMAIL }));
    expect(again.statusCode).toBe(429);

    const unknown = await env.handler(apiEvent('POST', '/identity/accounts/recover', { email: 'nobody@test.dev' }));
    expect(unknown.statusCode).toBe(200);
    expect(env.send).toHaveBeenCalledTimes(1);

    const no2fa = await env.handler(apiEvent('POST', '/identity/accounts/recover/two-factor', { email: EMAIL }));
    expect(no2fa.statusCode).toBe(200);
    expect(env.send).toHaveBeenCalledTimes(1);
  });

  it('resets the password, rotates auth, and wipes the vault', async () => {
    const env = makeEnv();
    await registerUser(env.handler);
    const tok = (await accessToken(env.handler)).body as unknown as string;
    const access = JSON.parse(tok).access_token as string;

    const created = await env.handler(
      apiEvent('POST', '/api/ciphers', { type: 1, name: 'site', login: { username: 'u', password: 'p' } }, access),
    );
    expect(created.statusCode).toBe(200);

    await env.handler(apiEvent('POST', '/identity/accounts/recover', { email: EMAIL }));
    const code = lastRecoveryCode(env);
    const pre = await env.handler(apiEvent('POST', '/identity/accounts/prelogin', { email: EMAIL }));
    const salt = JSON.parse(pre.body as string).salt;
    expect(typeof salt).toBe('string');
    expect(salt.length).toBeGreaterThan(0);

    const reset = await env.handler(
      apiEvent('POST', '/api/accounts/recover/reset', {
        email: EMAIL,
        code,
        newMasterPasswordHash: NEW_PASSWORD,
        key: 'new-akey',
        keys: { publicKey: 'new-pub', privateKey: 'new-priv' },
      }),
    );
    expect(reset.statusCode).toBe(200);

    const wrong = await accessToken(env.handler, PASSWORD);
    expect(wrong.statusCode).toBe(400);

    const login = await accessToken(env.handler, NEW_PASSWORD);
    expect(login.statusCode).toBe(200);
    const newAccess = JSON.parse(login.body as string).access_token as string;

    const ciphers = await env.handler(apiEvent('GET', '/api/ciphers', {}, newAccess));
    expect(JSON.parse(ciphers.body as string).data).toHaveLength(0);

    const replay = await env.handler(
      apiEvent('POST', '/api/accounts/recover/reset', {
        email: EMAIL,
        code,
        newMasterPasswordHash: NEW_PASSWORD,
        key: 'x',
        keys: {},
      }),
    );
    expect(replay.statusCode).toBe(400);
  });

  it('rejects a wrong code', async () => {
    const env = makeEnv();
    await registerUser(env.handler);
    const reset = await env.handler(
      apiEvent('POST', '/api/accounts/recover/reset', {
        email: EMAIL,
        code: '00000000',
        newMasterPasswordHash: NEW_PASSWORD,
        key: 'akey',
        keys: {},
      }),
    );
    expect(reset.statusCode).toBe(400);
  });
});
