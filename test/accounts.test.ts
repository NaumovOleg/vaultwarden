import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { profile, revisionDate, keys, sync, changePassword, changeKdf, rotateSecurityStamp, verifyPassword, deleteAccount, updateProfile } from '../src/endpoints/accounts';
import { register, sendVerificationEmail, token } from '../src/endpoints/identity';

const PASSWORD = Buffer.from('client-hash').toString('base64');
const NEW_PASSWORD = Buffer.from('new-client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/accounts/register/send-verification-email', handler: sendVerificationEmail },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'GET', pattern: '/api/accounts/profile', handler: profile, auth: true },
  { method: 'GET', pattern: '/api/accounts/revision-date', handler: revisionDate, auth: true },
  { method: 'POST', pattern: '/api/accounts/keys', handler: keys, auth: true },
  { method: 'GET', pattern: '/api/sync', handler: sync, auth: true },
  { method: 'POST', pattern: '/api/accounts/password', handler: changePassword, auth: true },
  { method: 'POST', pattern: '/api/accounts/kdf', handler: changeKdf, auth: true },
  { method: 'POST', pattern: '/api/accounts/security-stamp', handler: rotateSecurityStamp, auth: true },
  { method: 'POST', pattern: '/api/accounts/verify-password', handler: verifyPassword, auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
  { method: 'PUT', pattern: '/api/accounts/profile', handler: updateProfile, auth: true },
];

function makeEnv() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function ev(method: string, rawPath: string, body = '', token?: string, rawQueryString = ''): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = body.includes('grant_type') ? 'application/x-www-form-urlencoded' : 'application/json';
  return {
    rawPath,
    rawQueryString,
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function registerAndLogin(
  env: ReturnType<typeof makeEnv>,
  email: string,
  extra: Record<string, unknown> = {},
) {
  await env.handler(
    ev(
      'POST',
      '/identity/accounts/register',
      JSON.stringify({
        email,
        masterPasswordAuthentication: { hash: PASSWORD },
        key: 'akey-value',
        keys: { publicKey: 'pub-key', privateKey: 'priv-key' },
        ...extra,
      }),
    ),
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
        deviceIdentifier: 'dev-1',
        deviceType: '9',
      }).toString(),
    ),
  );
  expect(login.statusCode).toBe(200);
  return JSON.parse(login.body as string).access_token as string;
}

describe('profile + sync bundle', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('send-verification-email answers 200 (no SMTP: accounts are born verified)', async () => {
    const env = makeEnv();
    const r = await env.handler(ev('POST', '/identity/accounts/register/send-verification-email', JSON.stringify({ email: 'x@example.com' })));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toEqual({});
  });

  it('duplicate email resolves to the newest account', async () => {
    // Stale duplicate rows (test litter, re-registration races) must not win:
    // DynamoStore orders the GSI by createdAt (ScanIndexForward:false) so the
    // login hits the freshest account instead of an arbitrary storage row.
    const env = makeEnv();
    await env.handler(
      ev(
        'POST',
        '/identity/accounts/register',
        JSON.stringify({ email: 'dup@example.com', masterPasswordAuthentication: { hash: PASSWORD } }),
      ),
    );
    const first = await env.store.getUserByEmail('dup@example.com');
    await env.store.putUser({
      ...first!,
      id: 'dup2-id',
      pk: 'USER#dup2-id',
      createdAt: '2099-01-01T00:00:00.000Z',
    });
    expect((await env.store.getUserByEmail('dup@example.com'))!.id).toBe('dup2-id');
  });

  it('profile returns the full shape with explicit accountKeys', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'profile@example.com');
    const r = await env.handler(ev('GET', '/api/accounts/profile', '', at));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toEqual({
      id: expect.any(String),
      name: '',
      email: 'profile@example.com',
      emailVerified: true,
      premium: true,
      premiumFromOrganization: false,
      culture: 'en-US',
      twoFactorEnabled: false,
      key: 'akey-value',
      privateKey: 'priv-key',
      securityStamp: expect.any(String),
      organizations: [],
      providers: [],
      providerOrganizations: [],
      forcePasswordReset: false,
      avatarColor: '#607D8B',
      usesKeyConnector: false,
      creationDate: expect.any(String),
      _status: 1,
      accountKeys: {
        publicKeyEncryptionKeyPair: {
          encryptedPrivateKey: 'priv-key',
          publicKey: 'pub-key',
          object: 'keyPair',
        },
        securityState: null,
        signatureKeyPair: null,
        object: 'privateKeys',
      },
      object: 'profile',
    });
  });

  it('profile without keys → keyPair null but accountKeys present (pitfall 2.4)', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'nokeys@example.com', { keys: {} });
    const r = await env.handler(ev('GET', '/api/accounts/profile', '', at));
    const body = JSON.parse(r.body as string);
    expect(body.accountKeys).toEqual({
      publicKeyEncryptionKeyPair: null,
      securityState: null,
      signatureKeyPair: null,
      object: 'privateKeys',
    });
    expect(body.privateKey).toBeNull();
  });

  it('sync returns the full bundle; profile matches /profile exactly', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'sync@example.com');
    const s = await env.handler(ev('GET', '/api/sync', '', at));
    expect(s.statusCode).toBe(200);
    const body = JSON.parse(s.body as string);
    expect(body.object).toBe('sync');
    expect(body.folders).toEqual([]);
    expect(body.collections).toEqual([]);
    expect(body.policies).toEqual([]);
    expect(body.ciphers).toEqual([]);
    expect(body.sends).toEqual([]);
    expect(body.domains).toEqual({ equivalentDomains: [], globalEquivalentDomains: [], object: 'domains' });

    const p = await env.handler(ev('GET', '/api/accounts/profile', '', at));
    expect(body.profile).toEqual(JSON.parse(p.body as string));
  });

  it('excludeDomains=true → domains null', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'exclude@example.com');
    const r = await env.handler(ev('GET', '/api/sync', '', at, 'excludeDomains=true'));
    expect(JSON.parse(r.body as string).domains).toBeNull();
  });

  it('userDecryption: null without masterKey fields; exact shape when present', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'dec@example.com');
    const r = await env.handler(ev('GET', '/api/sync', '', at));
    expect(JSON.parse(r.body as string).userDecryption).toEqual({
      masterPasswordUnlock: null,
    });

    // Register path captures masterKey fields; simulate that on a second user.
    const at2 = await registerAndLogin(env, 'dec2@example.com', {
      masterKeyEncryptedUserKey: 'enc-user-key',
      masterKeyWrappedUserKey: 'wrapped-user-key',
    });
    const r2 = await env.handler(ev('GET', '/api/sync', '', at2));
    expect(JSON.parse(r2.body as string).userDecryption).toEqual({
      masterPasswordUnlock: {
        kdf: { kdfType: 0, kdfIterations: 600_000, kdfMemory: null, kdfParallelism: null },
        masterKeyEncryptedUserKey: 'enc-user-key',
        masterKeyWrappedUserKey: 'wrapped-user-key',
        salt: 'dec2@example.com',
      },
    });
  });

  it('sync?partial=true returns profile+folders only', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'partial@example.com');
    const r = await env.handler(ev('GET', '/api/sync', '', at, 'partial=true'));
    const body = JSON.parse(r.body as string);
    expect(Object.keys(body).sort()).toEqual(['folders', 'object', 'profile']);
  });

  it('revision-date returns ms epoch close to now', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'rev@example.com');
    const r = await env.handler(ev('GET', '/api/accounts/revision-date', '', at));
    expect(r.statusCode).toBe(200);
    const ms = JSON.parse(r.body as string).revisionDate;
    expect(typeof ms).toBe('number');
    expect(String(ms)).toMatch(/^\d{13}$/);
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
  });

  it('POST /api/accounts/keys stores keys verbatim', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'keys@example.com');
    const r = await env.handler(
      ev('POST', '/api/accounts/keys', JSON.stringify({ publicKey: 'new-pub', privateKey: 'new-priv' }), at),
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toEqual({
      publicKey: 'new-pub',
      encryptedPrivateKey: 'new-priv',
      object: 'keys',
    });
    const user = await env.store.getUserByEmail('keys@example.com');
    expect(user!.publicKey).toBe('new-pub');
    expect(user!.privateKey).toBe('new-priv');
  });

  it('all four endpoints 401 without a bearer token', async () => {
    const env = makeEnv();
    for (const path of ['/api/accounts/profile', '/api/accounts/revision-date', '/api/sync']) {
      const r = await env.handler(ev('GET', path));
      expect(r.statusCode).toBe(401);
    }
    const r = await env.handler(ev('POST', '/api/accounts/keys', '{}'));
    expect(r.statusCode).toBe(401);
  });
});

describe('account management', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('password change: wrong old hash 400; ok hash rotates stamp + old sessions die', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'pwd@example.com');

    const wrong = await env.handler(
      ev('POST', '/api/accounts/password', JSON.stringify({ masterPasswordHash: 'AAAAAA==' }), at),
    );
    expect(wrong.statusCode).toBe(400);
    expect(JSON.parse(wrong.body as string).Message).toBe('Invalid password.');

    const ok = await env.handler(
      ev(
        'POST',
        '/api/accounts/password',
        JSON.stringify({
          masterPasswordHash: PASSWORD,
          newMasterPasswordHash: NEW_PASSWORD,
          key: 'new-akey',
          masterPasswordHint: 'new hint',
          kdf: { kdfType: 0, kdfIterations: 600_000 },
          keys: { publicKey: 'npub', privateKey: 'npriv' },
        }),
        at,
      ),
    );
    expect(ok.statusCode).toBe(200);

    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at))).statusCode).toBe(401);

    const user = await env.store.getUserByEmail('pwd@example.com');
    expect(user!.akey).toBe('new-akey');
    expect(user!.masterPasswordHint).toBe('new hint');
    expect(user!.privateKey).toBe('npriv');
    expect(user!.securityStamp).not.toBe(at);

    const oldLogin = await env.handler(
      ev(
        'POST',
        '/identity/connect/token',
        new URLSearchParams({
          grant_type: 'password',
          username: 'pwd@example.com',
          password: PASSWORD,
          scope: 'api offline_access',
          deviceIdentifier: 'dev-1',
        }).toString(),
      ),
    );
    expect(oldLogin.statusCode).toBe(400);
    expect(JSON.parse(oldLogin.body as string).error).toBe('invalid_grant');

    const newLogin = await env.handler(
      ev(
        'POST',
        '/identity/connect/token',
        new URLSearchParams({
          grant_type: 'password',
          username: 'pwd@example.com',
          password: NEW_PASSWORD,
          scope: 'api offline_access',
          deviceIdentifier: 'dev-1',
        }).toString(),
      ),
    );
    expect(newLogin.statusCode).toBe(200);
  });

  it('kdf change persists and prelogin/kdf fields update', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'kdf@example.com');
    const r = await env.handler(
      ev(
        'POST',
        '/api/accounts/kdf',
        JSON.stringify({ masterPasswordHash: PASSWORD, kdf: { kdfType: 0, kdfIterations: 300_000 } }),
        at,
      ),
    );
    expect(r.statusCode).toBe(200);
    const user = await env.store.getUserByEmail('kdf@example.com');
    expect(user!.kdfIterations).toBe(300_000);
    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at))).statusCode).toBe(401);
  });

  it('verify-password: ok → MasterPasswordPolicy envelope; wrong → 400', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'vp@example.com');
    const ok = await env.handler(
      ev('POST', '/api/accounts/verify-password', JSON.stringify({ masterPasswordHash: PASSWORD }), at),
    );
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body as string)).toEqual({ MasterPasswordPolicy: { Object: 'masterPasswordPolicy' } });
    const wrong = await env.handler(
      ev('POST', '/api/accounts/verify-password', JSON.stringify({ masterPasswordHash: 'AAAAAA==' }), at),
    );
    expect(wrong.statusCode).toBe(400);
  });

  it('security-stamp rotates stamp; sessions 401; re-login works', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'stamp@example.com');
    const r = await env.handler(
      ev('POST', '/api/accounts/security-stamp', JSON.stringify({ masterPasswordHash: PASSWORD }), at),
    );
    expect(r.statusCode).toBe(200);
    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at))).statusCode).toBe(401);
    const at2 = await registerAndLogin(env, 'stamp@example.com');
    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at2))).statusCode).toBe(200);
  });

  it('profile update: PUT {name, avatarColor} → updated profileJson', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'prof@example.com');
    const r = await env.handler(
      ev('PUT', '/api/accounts/profile', JSON.stringify({ name: 'Bob', avatarColor: '#111111' }), at),
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.name).toBe('Bob');
    expect(body.avatarColor).toBe('#111111');
  });

  it('delete account: data + user rows gone, email reusable, sessions dead', async () => {
    const env = makeEnv();
    const at = await registerAndLogin(env, 'gone@example.com');
    const del = await env.handler(
      ev('POST', '/api/accounts/delete', JSON.stringify({ masterPasswordHash: PASSWORD }), at),
    );
    expect(del.statusCode).toBe(200);
    expect(await env.store.getUserByEmail('gone@example.com')).toBeNull();
    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at))).statusCode).toBe(401);

    const relogin = await env.handler(
      ev(
        'POST',
        '/identity/connect/token',
        new URLSearchParams({
          grant_type: 'password',
          username: 'gone@example.com',
          password: PASSWORD,
          scope: 'api offline_access',
          deviceIdentifier: 'dev-1',
        }).toString(),
      ),
    );
    expect(relogin.statusCode).toBe(400);

    const reg = await env.handler(
      ev('POST', '/identity/accounts/register', JSON.stringify({ email: 'gone@example.com', masterPasswordAuthentication: { hash: PASSWORD } })),
    );
    expect(reg.statusCode).toBe(200);
    expect((await env.handler(ev('GET', '/api/accounts/profile', '', at))).statusCode).toBe(401);
  });
});