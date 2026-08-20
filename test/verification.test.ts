import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import type { Mailer } from '../src/ses';
import { MemoryStore } from '../src/store';
import { register, token, sendVerificationEmail } from '../src/endpoints/identity';
import { changeEmail, verifyEmail, verifyPassword } from '../src/endpoints/accounts';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/register/finish', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/register/send-verification-email', handler: (p, ctx) => sendVerificationEmail(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/email', handler: (p, ctx) => changeEmail(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/accounts/verify-email', handler: (p, ctx) => verifyEmail(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/verify-password', handler: (p, ctx) => verifyPassword(p, ctx), auth: true },
];

const PASSWORD = Buffer.from('client-hash').toString('base64');
const EMAIL = 'verify-me@test.dev';
const OTHER_EMAIL = 'verify-me-2@test.dev';

function makeEnv() {
  process.env.SIGNUPS_ALLOWED = 'true';
  const prevSes = process.env.SES_SOURCE;
  process.env.SES_SOURCE = 'no-reply@mock.dev';
  const send = jest.fn<Promise<void>, [string, string, string]>();
  const mailer: Mailer = { send };
  const store = new MemoryStore();
  return {
    store,
    send,
    handler: createHandler(routes, { store, mailer }),
    restore: () => {
      process.env.SIGNUPS_ALLOWED = 'false';
      if (prevSes === undefined) delete process.env.SES_SOURCE;
      else process.env.SES_SOURCE = prevSes;
    },
  };
}

function apiEvent(method: string, rawPath: string, body: unknown, token?: string): APIGatewayProxyEventV2 {
  return {
    rawPath,
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      host: 'vault.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

function formEvent(parts: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    rawPath: '/identity/connect/token',
    body: new URLSearchParams(parts).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'vault.test',
    },
    requestContext: { http: { method: 'POST' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function accessToken(handler: (e: APIGatewayProxyEventV2) => Promise<any>) {
  const r = await handler(
    formEvent({
      grant_type: 'password',
      username: EMAIL,
      password: PASSWORD,
      scope: 'api offline_access',
      deviceIdentifier: 'dev-1',
      deviceType: '9',
    }),
  );
  expect(r.statusCode).toBe(200);
  return JSON.parse(r.body as string).access_token as string;
}

function linkParts(send: ReturnType<typeof makeEnv>['send'], which: number): { userId: string; token: string } {
  const body = send.mock.calls[which][2];
  const userId = /userId=([A-Za-z0-9_-]+)/.exec(body)?.[1];
  const token = /token=([A-Za-z0-9_-]+)/.exec(body)?.[1];
  expect(userId).toBeTruthy();
  expect(token).toBeTruthy();
  return { userId: userId!, token: token! };
}

function lastSendBody(send: ReturnType<typeof makeEnv>['send']): string {
  return send.mock.calls[send.mock.calls.length - 1][2];
}

async function registerVerified(env: ReturnType<typeof makeEnv>, email: string) {
  const pre = await env.handler(apiEvent('POST', '/identity/accounts/register/send-verification-email', { email }));
  expect(pre.statusCode).toBe(204);
  const token = /emailVerificationToken=([A-Za-z0-9_-]+)/.exec(lastSendBody(env.send))?.[1];
  expect(token).toBeTruthy();
  const reg = await env.handler(
    apiEvent('POST', '/identity/accounts/register', {
      email,
      emailVerificationToken: token,
      masterPasswordAuthentication: { hash: PASSWORD },
      key: 'akey',
      keys: { publicKey: 'pub', privateKey: 'priv' },
    }),
  );
  expect(reg.statusCode).toBe(200);
}

describe('email verification + change', () => {
  afterEach(() => {
    process.env.SIGNUPS_ALLOWED = 'false';
    delete process.env.SES_SOURCE;
  });

  it('token-less register is born verified (mobile flow: no mailer link exists, SES sandbox blocks fresh recipients)', async () => {
    const env = makeEnv();
    // Registration without a token — Android/CLI path — must not create an
    // account that can never log in.
    const reg = await env.handler(
      apiEvent('POST', '/identity/accounts/register', {
        email: EMAIL,
        masterPasswordAuthentication: { hash: PASSWORD },
        key: 'akey',
        keys: { publicKey: 'pub', privateKey: 'priv' },
      }),
    );
    expect(reg.statusCode).toBe(200);

    // Login works immediately.
    const ok = await accessToken(env.handler);
    expect(ok).toBeDefined();

    // The verify-email machinery stays for token flows: the web vault's
    // send-verification-email mails a finish-signup link with a single-use
    // token that registers a second account.
    const pre = await env.handler(apiEvent('POST', '/identity/accounts/register/send-verification-email', { email: OTHER_EMAIL }));
    expect(pre.statusCode).toBe(204);
    const token = /emailVerificationToken=([A-Za-z0-9_-]+)/.exec(lastSendBody(env.send))?.[1];
    expect(token).toBeTruthy();
    const second = await env.handler(
      apiEvent('POST', '/identity/accounts/register/finish', {
        email: OTHER_EMAIL,
        emailVerificationToken: token,
        masterPasswordHash: PASSWORD,
        userSymmetricKey: 'usymkey',
        userAsymmetricKeys: { publicKey: 'pub', encryptedPrivateKey: 'priv' },
        kdf: 0,
        kdfIterations: 600000,
      }),
    );
    expect(second.statusCode).toBe(200);
    const created = await env.store.getUserByEmail(OTHER_EMAIL);
    expect(created!.akey).toBe('usymkey');
    expect(created!.emailVerified).toBe(true);
  });

  it('changes email only after the new address confirms its link', async () => {
    const env = makeEnv();
    await registerVerified(env, EMAIL);
    const tok = await accessToken(env.handler);

    const change = await env.handler(
      apiEvent('POST', '/api/accounts/email', { email: 'new-addr@test.dev', masterPasswordHash: PASSWORD }, tok),
    );
    expect(change.statusCode).toBe(200);
    expect(env.send).toHaveBeenCalledTimes(2);
    const link = linkParts(env.send, 1);

    // Password still verified (email is unchanged until confirm).
    const vp = await env.handler(apiEvent('POST', '/api/accounts/verify-password', { masterPasswordHash: PASSWORD }, tok));
    expect(vp.statusCode).toBe(200);

    const verify = await env.handler(apiEvent('POST', '/api/accounts/verify-email', { userId: link.userId, token: link.token }));
    expect(verify.statusCode).toBe(200);

    const user = await env.store.getUserByEmail('new-addr@test.dev');
    expect(user).not.toBeNull();
    expect(env.store.getUserByEmail(EMAIL)).resolves.toBeNull();

    // Login works with the new address.
    const relogin = await env.handler(
      formEvent({
        grant_type: 'password',
        username: 'new-addr@test.dev',
        password: PASSWORD,
        scope: 'api offline_access',
        deviceIdentifier: 'dev-1',
        deviceType: '9',
      }),
    );
    expect(relogin.statusCode).toBe(200);
  });

  it('rejects a change to an email that is already taken', async () => {
    const env = makeEnv();
    await registerVerified(env, EMAIL);
    const initialSends = env.send.mock.calls.length;
    await registerVerified(env, 'other@test.dev');
    expect(env.send).toHaveBeenCalledTimes(initialSends + 1);
    const tok = await accessToken(env.handler);

    const change = await env.handler(
      apiEvent('POST', '/api/accounts/email', { email: 'other@test.dev', masterPasswordHash: PASSWORD }, tok),
    );
    expect(change.statusCode).toBe(400);
    expect(env.send).toHaveBeenCalledTimes(initialSends + 1);
  });
});