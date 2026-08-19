import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { pbkdf2Sync } from 'node:crypto';
import { totpCode } from '../src/crypto';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/prelogin', handler: (p, ctx) => prelogin(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/endsession', handler: (p, ctx) => endsession(p, ctx) },
];

import { register, prelogin, token, endsession } from '../src/endpoints/identity';

function makeHandler() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

const PASSWORD = Buffer.from('the-client-side-hash').toString('base64');

function formEvent(parts: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    rawPath: '/identity/connect/token',
    body: new URLSearchParams(parts).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { http: { method: 'POST' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function registerUser(handler: (e: APIGatewayProxyEventV2) => Promise<any>, email: string) {
  const r = await handler({
    rawPath: '/identity/accounts/register',
    body: JSON.stringify({
      email,
      masterPasswordAuthentication: { hash: PASSWORD },
      key: 'akey-value',
      keys: { publicKey: 'pub', privateKey: 'priv' },
    }),
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2);
  expect(r.statusCode).toBe(200);
}

function loginBody(username: string, overrides: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return formEvent({
    grant_type: 'password',
    username,
    password: PASSWORD,
    scope: 'api offline_access',
    client_id: 'web',
    deviceType: '9',
    deviceIdentifier: 'dev-1',
    deviceName: 'Test Browser',
    ...overrides,
  });
}

describe('connect/token protocol', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('password grant returns the full exact response shape', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'happy@example.com');
    const r = await handler(loginBody('happy@example.com'));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    // The 2026 SDK decodes the access token as a JWT (3 parts, sub = userId).
    expect(body.access_token.split('.')).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(body.access_token.split('.')[1], 'base64url').toString('utf8'),
    );
    expect(payload.sub).toEqual(expect.any(String));
    expect(body).toEqual({
      access_token: expect.any(String),
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'api offline_access',
      refresh_token: expect.any(String),
      Key: 'akey-value',
      PrivateKey: 'priv',
      Kdf: 0,
      KdfIterations: 600_000,
      KdfMemory: null,
      KdfParallelism: null,
      ResetMasterPassword: false,
      ForcePasswordReset: false,
      MasterPasswordPolicy: null,
      AccountKeys: {
        publicKeyEncryptionKeyPair: {
          wrappedPrivateKey: 'priv',
          publicKey: 'pub',
          Object: 'publicKeyEncryptionKeyPair',
        },
        Object: 'privateKeys',
      },
      UserDecryptionOptions: {
        HasMasterPassword: true,
        MasterPasswordUnlock: {
          Kdf: { KdfType: 0, Iterations: 600_000, Memory: null, Parallelism: null },
          MasterKeyEncryptedUserKey: 'akey-value',
          MasterKeyWrappedUserKey: 'akey-value',
          Salt: expect.any(String),
        },
        Object: 'userDecryptionOptions',
      },
      ApiKeyClientSecretHint: null,
      securityStamp: expect.any(String),
      passwordlessLogin: false,
      TwoFactorProviders: null,
    });
  });

  it('refresh rotates the pair; the old refresh token dies', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'rotate@example.com');
    const login = JSON.parse((await handler(loginBody('rotate@example.com'))).body as string);

    const refresh = formEvent({
      grant_type: 'refresh_token',
      refresh_token: login.refresh_token,
      client_id: 'web',
    });
    const r = await handler(refresh);
    expect(r.statusCode).toBe(200);
    const rotated = JSON.parse(r.body as string);
    expect(rotated.refresh_token).not.toBe(login.refresh_token);
    expect(rotated.access_token).not.toBe(login.access_token);

    const replay = await handler(formEvent({ grant_type: 'refresh_token', refresh_token: login.refresh_token }));
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body as string)).toEqual({ error: 'invalid_grant' });
  });

  it('endsession deletes the pair; refresh afterwards 400s', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'out@example.com');
    const login = JSON.parse((await handler(loginBody('out@example.com'))).body as string);

    const out = formEvent({ refresh_token: login.refresh_token });
    out.rawPath = '/identity/connect/endsession';
    const end = await handler(out);
    expect(end.statusCode).toBe(200);
    expect(JSON.parse(end.body as string)).toEqual({});

    const refresh = await handler(formEvent({ grant_type: 'refresh_token', refresh_token: login.refresh_token }));
    expect(refresh.statusCode).toBe(400);
    expect(JSON.parse(refresh.body as string)).toEqual({ error: 'invalid_grant' });
  });

  it('wrong password returns the exact 400 invalid_grant body, never 401', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'wrongpw@example.com');
    const r = await handler(
      loginBody('wrongpw@example.com', { password: Buffer.from('nope').toString('base64') }),
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body as string)).toEqual({
      error: 'invalid_grant',
      error_description: 'Username or password is incorrect.',
    });
  });

  it('unknown email and wrong password produce identical responses', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'known@example.com');
    const wrong = await handler(
      loginBody('known@example.com', { password: Buffer.from('nope').toString('base64') }),
    );
    const ghost = await handler(loginBody('ghost@example.com'));
    expect(JSON.parse(wrong.body as string)).toEqual(JSON.parse(ghost.body as string));
    expect(wrong.statusCode).toBe(ghost.statusCode);
  });

  it('missing username returns invalid_grant', async () => {
    const { handler } = makeHandler();
    const r = await handler(loginBody(''));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body as string).error).toBe('invalid_grant');
  });

  it('disabled user returns the disabled message', async () => {
    const { handler, store } = makeHandler();
    await registerUser(handler, 'off@example.com');
    const user = (await store.getUserByEmail('off@example.com'))!;
    await store.putUser({ ...user, enabled: false });
    const r = await handler(loginBody('off@example.com'));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body as string)).toEqual({
      error: 'invalid_grant',
      error_description: 'This user has been disabled',
    });
  });

  it('2FA flow: second call with the token issues the pair, token is single-use', async () => {
    const { handler, store } = makeHandler();
    await registerUser(handler, 'tfa@example.com');
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const user = (await store.getUserByEmail('tfa@example.com'))!;
    await store.putUser({ ...user, twoFactorEnabled: true, totpSecret: secret });

    const first = await handler(loginBody('tfa@example.com'));
    expect(first.statusCode).toBe(200);
    const envelope = JSON.parse(first.body as string);
    expect(envelope).toEqual({
      error: 'invalid_grant',
      error_description: 'Two factor required.',
      TwoFactorProviders: [0],
      TwoFactorProviders2: { '0': { Object: 'twoFactorAuthenticator', Enabled: true } },
      MasterPasswordPolicy: { Object: 'masterPasswordPolicy' },
      TwoFactorToken: expect.any(String),
    });

    const second = await handler(
      loginBody('tfa@example.com', {
        twoFactorToken: envelope.TwoFactorToken,
        twoFactorProvider: '0',
        twoFactorCode: totpCode(secret),
      }),
    );
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body as string).access_token).toBeDefined();

    // Replaying a consumed TFA token fails.
    const replay = await handler(
      loginBody('tfa@example.com', {
        twoFactorToken: envelope.TwoFactorToken,
        twoFactorProvider: '0',
        twoFactorCode: totpCode(secret),
      }),
    );
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body as string)).toEqual({ error: 'invalid_grant' });
  });

  it('2FA via legacy headers works', async () => {
    const { handler, store } = makeHandler();
    await registerUser(handler, 'legacy2fa@example.com');
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const user = (await store.getUserByEmail('legacy2fa@example.com'))!;
    await store.putUser({ ...user, twoFactorEnabled: true, totpSecret: secret });

    const first = await handler(loginBody('legacy2fa@example.com'));
    const tfa = JSON.parse(first.body as string).TwoFactorToken;

    const ev = loginBody('legacy2fa@example.com', { twoFactorToken: tfa, twoFactorProvider: '0' });
    (ev.headers as any)['auth-2fa'] = totpCode(secret);
    (ev.headers as any)['x-requested-with'] = 'XMLHttpRequest';
    (ev.headers as any)['auth-2fa-remember'] = 'true';
    const second = await handler(ev);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body as string).access_token).toBeDefined();
  });

  it('rate limit: threshold blocks 429, success clears the counter', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'ratelimited@example.com');
    const wrong = Buffer.from('nope').toString('base64');

    // Per-account lock kicks in after 5 failures against a known email.
    // 4 failures are under the threshold — all plain 400s.
    for (let i = 0; i < 4; i++) {
      const r = await handler(loginBody('ratelimited@example.com', { password: wrong }));
      expect(r.statusCode).toBe(400);
    }

    // Success below the threshold clears the counter.
    const ok = await handler(loginBody('ratelimited@example.com'));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body as string).access_token).toBeDefined();

    // Fresh counter: 5 failures then the 6th attempt (even with the correct
    // password) is blocked 429 while the lock window is open.
    for (let i = 0; i < 5; i++) {
      const r = await handler(loginBody('ratelimited@example.com', { password: wrong }));
      expect(r.statusCode).toBe(400);
    }
    const blocked = await handler(loginBody('ratelimited@example.com'));
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body as string).Message).toBe(
      'Too many login attempts. Try again later.',
    );
  });

  it('2026 flow: register with client salt → prelogin returns it → login with derived hash', async () => {
    const { handler } = makeHandler();
    const iter = 4096;
    const salt = 'dGhlLWNsaWVudC1zYWx0MjAyNg=='; // base64("the-client-salt2026")
    const clientHash = pbkdf2Sync('master-password', Buffer.from(salt, 'base64'), iter, 32, 'sha256').toString('base64');

    const reg = await handler({
      rawPath: '/identity/accounts/register',
      body: JSON.stringify({
        email: 'realistic@example.com',
        masterPasswordAuthentication: {
          salt,
          kdf: { kdfType: 0, kdfIterations: iter },
          masterPasswordAuthenticationHash: clientHash,
        },
        masterPasswordUnlock: { masterKeyWrappedUserKey: 'wrapped-user-key' },
      }),
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' }, requestId: 'tr' },
    } as unknown as APIGatewayProxyEventV2);
    expect(reg.statusCode).toBe(200);

    const pre = await handler({
      rawPath: '/identity/accounts/prelogin',
      body: JSON.stringify({ email: 'realistic@example.com' }),
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' }, requestId: 'tr' },
    } as unknown as APIGatewayProxyEventV2);
    expect(JSON.parse(pre.body as string).salt).toBe(salt);

    const login = await handler(loginBody('realistic@example.com', { password: clientHash }));
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body as string).access_token).toBeDefined();
  });

  it('2026 flow: non-canonical client salt is stored verbatim (re-encoding truncated it, breaking unlock)', async () => {
    const { handler } = makeHandler();
    const iter = 4096;
    // 25 chars — not a multiple of 4. base64-decoding it yields 18 bytes and
    // re-encoding drops the trailing 'e', so the old code stored
    // "postdeployfree+bertonlin" and the client's wrapped keys no longer
    // unwrap against the salt prelogin returned.
    const salt = 'postdeployfree+bertonline';
    const clientHash = pbkdf2Sync('master-password', Buffer.from(salt, 'base64'), iter, 32, 'sha256').toString('base64');

    const reg = await handler({
      rawPath: '/identity/accounts/register',
      body: JSON.stringify({
        email: 'odd-salt@example.com',
        masterPasswordAuthentication: {
          salt,
          kdf: { kdfType: 0, kdfIterations: iter },
          masterPasswordAuthenticationHash: clientHash,
        },
        masterPasswordUnlock: { masterKeyWrappedUserKey: 'wrapped-user-key' },
      }),
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' }, requestId: 'tr' },
    } as unknown as APIGatewayProxyEventV2);
    expect(reg.statusCode).toBe(200);

    const pre = await handler({
      rawPath: '/identity/accounts/prelogin',
      body: JSON.stringify({ email: 'odd-salt@example.com' }),
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' }, requestId: 'tr' },
    } as unknown as APIGatewayProxyEventV2);
    const preBody = JSON.parse(pre.body as string);
    expect(preBody.salt).toBe(salt);

    const login = await handler(loginBody('odd-salt@example.com', { password: clientHash }));
    expect(login.statusCode).toBe(200);
    const tokenBody = JSON.parse(login.body as string);
    // Vaultwarden always reports the email as Salt here; the client-side Salt
    // slot is unused for password derivation on login.
    expect(tokenBody.UserDecryptionOptions.MasterPasswordUnlock.Salt).toBe('odd-salt@example.com');
  });

  it('2026 SDK style: JSON body with nested masterPasswordAuthentication', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'sdk@example.com');
    const r = await handler({
      rawPath: '/identity/connect/token',
      body: JSON.stringify({
        grant_type: 'password',
        username: 'sdk@example.com',
        scope: 'api offline_access',
        client_id: 'sdk',
        masterPasswordAuthentication: {
          salt: null,
          kdf: { kdfType: 0, kdfIterations: 600_000 },
          masterPasswordAuthenticationHash: PASSWORD,
        },
      }),
      headers: { 'content-type': 'application/json' },
      requestContext: { http: { method: 'POST' }, requestId: 'tr' },
    } as unknown as APIGatewayProxyEventV2);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string).access_token).toBeDefined();
  });

  it('password field wins over masterPasswordHash; legacy MasterPasswordHash works', async () => {
    const { handler } = makeHandler();
    await registerUser(handler, 'fields@example.com');
    const both = await handler(
      loginBody('fields@example.com', {
        masterPasswordHash: Buffer.from('wrong-legacy').toString('base64'),
      }),
    );
    expect(both.statusCode).toBe(200);

    const legacy = formEvent({
      grant_type: 'password',
      username: 'fields@example.com',
      MasterPasswordHash: PASSWORD,
      scope: 'api offline_access',
    });
    const r = await handler(legacy);
    expect(r.statusCode).toBe(200);
  });

  it('stamp change revokes sessions (password change semantics)', async () => {
    const { handler, store } = makeHandler();
    await registerUser(handler, 'stamped@example.com');
    const login = JSON.parse((await handler(loginBody('stamped@example.com'))).body as string);

    // Simulate force-password-reset / master-password change.
    const user = (await store.getUserByEmail('stamped@example.com'))!;
    await store.putUser({ ...user, securityStamp: 'new-stamp' });

    const refresh = await handler(formEvent({ grant_type: 'refresh_token', refresh_token: login.refresh_token }));
    expect(refresh.statusCode).toBe(400);
    expect(JSON.parse(refresh.body as string)).toEqual({ error: 'invalid_grant' });
  });

  it('session storage carries stamp snapshots and TTLs', async () => {
    const { handler, store } = makeHandler();
    await registerUser(handler, 'snapshot@example.com');
    const login = JSON.parse((await handler(loginBody('snapshot@example.com'))).body as string);
    const user = (await store.getUserByEmail('snapshot@example.com'))!;

    const access = await store.getSession(login.access_token);
    const refresh = await store.getSession(login.refresh_token);
    expect(access!.stamp).toBe(user.securityStamp);
    expect(refresh!.stamp).toBe(user.securityStamp);
    expect(access!.expiresAt).toBeCloseTo(Math.floor(Date.now() / 1000) + 3600, -2);
    expect(refresh!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
    expect(refresh!.pairedAccess).toBe(login.access_token);
  });
});