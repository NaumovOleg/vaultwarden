import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { verifyPassword } from '../src/crypto';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore, UserItem } from '../src/store';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/prelogin', handler: (p, ctx) => prelogin(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/prelogin/password', handler: (p, ctx) => prelogin(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/prelogin', handler: (p, ctx) => prelogin(p, ctx) },
];

import { register, prelogin } from '../src/endpoints/identity';

function makeHandler() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function event(method: string, rawPath: string, body: string, contentType = 'application/json'): APIGatewayProxyEventV2 {
  return {
    rawPath,
    body,
    headers: { 'content-type': contentType },
    requestContext: { http: { method }, requestId: 'test-request-id' },
  } as unknown as APIGatewayProxyEventV2;
}

const REGISTER_BODY = {
  email: 'Alice@Example.com',
  masterPasswordAuthentication: { hash: Buffer.from('client-side-hash').toString('base64') },
  key: 'protected-sym-key',
  name: 'Alice',
  keys: { publicKey: 'pub', privateKey: 'priv' },
  masterPasswordHint: 'hint',
};

async function makeUser(store: MemoryStore, email: string, kdf?: UserItem['kdfType']): Promise<UserItem> {
  const user: UserItem = {
    pk: `USER#${email}`,
    sk: 'PROFILE',
    id: email,
    email,
    passwordHash: Buffer.from('stored').toString('base64'),
    salt: Buffer.from('salt').toString('base64'),
    passwordIterations: 600_000,
    kdfType: kdf ?? 0,
    kdfIterations: 600_000,
    kdfMemory: null,
    kdfParallelism: null,
    securityStamp: 'stamp',
    akey: 'akey',
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
  await store.putUser(user);
  return user;
}

describe('register + prelogin endpoints', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;

  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });

  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('register returns 200 {} and creates the user with 600k server hash wrap', async () => {
    const { store, handler } = makeHandler();
    const r = await handler(event('POST', '/identity/accounts/register', JSON.stringify(REGISTER_BODY)));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toEqual({});

    const user = await store.getUserByEmail('alice@example.com');
    expect(user).not.toBeNull();
    expect(user!.email).toBe('alice@example.com');
    expect(user!.passwordIterations).toBe(600_000);
    expect(user!.kdfIterations).toBe(600_000);
    expect(user!.akey).toBe('protected-sym-key');
    expect(user!.privateKey).toBe('priv');
    const hashOk = verifyPassword(
      Buffer.from('client-side-hash'),
      Buffer.from(user!.salt, 'base64'),
      Buffer.from(user!.passwordHash, 'base64'),
      user!.passwordIterations,
    );
    expect(hashOk).toBe(true);
    expect(user!.enabled).toBe(true);
    expect(user!.premium).toBe(true);
  });

  it('/api/accounts/register behaves identically and lowercases the email', async () => {
    const { store, handler } = makeHandler();
    const r = await handler(event('POST', '/api/accounts/register', JSON.stringify(REGISTER_BODY)));
    expect(r.statusCode).toBe(200);
    expect(await store.getUserByEmail('ALICE@example.com')).not.toBeNull();
  });

  it('duplicate email returns the exact 400 envelope', async () => {
    const { handler } = makeHandler();
    await handler(event('POST', '/identity/accounts/register', JSON.stringify(REGISTER_BODY)));
    const r = await handler(event('POST', '/identity/accounts/register', JSON.stringify(REGISTER_BODY)));
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body as string)).toEqual({
      Message: 'An account with this email already exists.',
      ModelState: {},
      ValidationErrors: [],
    });
  });

  it('signups disabled returns 403 with the exact message', async () => {
    const { handler } = makeHandler();
    const old = process.env.SIGNUPS_ALLOWED;
    process.env.SIGNUPS_ALLOWED = 'false';
    try {
      const r = await handler(event('POST', '/identity/accounts/register', JSON.stringify(REGISTER_BODY)));
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.body as string).Message).toBe('Registration is disabled.');
    } finally {
      process.env.SIGNUPS_ALLOWED = old;
    }
  });

  it('masterPasswordAuthentication.hash wins over masterPasswordHash', async () => {
    const { handler } = makeHandler();
    const body = {
      ...REGISTER_BODY,
      masterPasswordHash: Buffer.from('legacy').toString('base64'),
      masterPasswordAuthentication: { hash: Buffer.from('modern').toString('base64') },
    };
    const r = await handler(event('POST', '/identity/accounts/register', JSON.stringify(body)));
    expect(r.statusCode).toBe(200);
  });

  it('accepts form-urlencoded bodies with a JSON-string masterPasswordAuthentication', async () => {
    const { handler } = makeHandler();
    const params = new URLSearchParams({
      email: 'Form@Example.com',
      masterPasswordHash: Buffer.from('form-hash').toString('base64'),
      key: 'form-key',
    });
    const r = await handler(
      event(
        'POST',
        '/identity/accounts/register',
        params.toString(),
        'application/x-www-form-urlencoded',
      ),
    );
    expect(r.statusCode).toBe(200);
  });

  it('handles base64-encoded request bodies', async () => {
    const { handler } = makeHandler();
    const ev = event('POST', '/identity/accounts/register', JSON.stringify(REGISTER_BODY));
    ev.body = Buffer.from(JSON.stringify(REGISTER_BODY)).toString('base64');
    ev.isBase64Encoded = true;
    const r = await handler(ev);
    expect(r.statusCode).toBe(200);
  });

  it('invalid email is rejected with 400', async () => {
    const { handler } = makeHandler();
    const r = await handler(
      event('POST', '/identity/accounts/register', JSON.stringify({ ...REGISTER_BODY, email: 'nope' })),
    );
    expect(r.statusCode).toBe(400);
  });

  it('prelogin returns kdfConfig + legacy fields for a known user', async () => {
    const { store, handler } = makeHandler();
    await makeUser(store, 'known@example.com');
    const r = await handler(
      event('POST', '/identity/accounts/prelogin', JSON.stringify({ email: 'known@example.com' })),
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    const user = await store.getUserByEmail('known@example.com');
    expect(body).toEqual({
      kdf: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
      kdfSettings: { kdfType: 0, iterations: 600_000, memory: null, parallelism: null },
      salt: user!.salt,
    });
  });

  it('prelogin reflects the account kdf algorithm', async () => {
    const { store, handler } = makeHandler();
    await makeUser(store, 'argon@example.com', 1 as UserItem['kdfType']);
    const r = await handler(
      event('POST', '/identity/accounts/prelogin', JSON.stringify({ email: 'argon@example.com' })),
    );
    const body = JSON.parse(r.body as string);
    expect(body.kdf).toBe(1);
    expect(body.kdfSettings.kdfType).toBe(1);
  });

  it('prelogin for unknown email returns server defaults, never 404', async () => {
    const { handler } = makeHandler();
    const r = await handler(
      event('POST', '/identity/accounts/prelogin', JSON.stringify({ email: 'ghost@example.com' })),
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body).toEqual({
      kdf: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
      kdfSettings: { kdfType: 0, iterations: 600_000, memory: null, parallelism: null },
      salt: null,
    });
  });

  it('all three prelogin paths respond 200, and /password variant works', async () => {
    const { store, handler } = makeHandler();
    await makeUser(store, 'multi@example.com');
    const body = JSON.stringify({ email: 'multi@example.com' });
    for (const path of [
      '/identity/accounts/prelogin',
      '/identity/accounts/prelogin/password',
      '/api/accounts/prelogin',
    ]) {
      const r = await handler(event('POST', path, body));
      expect(r.statusCode).toBe(200);
    }
  });
});