// Security regression suite: every test here exists because a hardening
// finding named a real gap (see docs/security-hardening.md). If a test
// breaks, re-check the finding before touching the test.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { signJwt } from '../src/crypto';
import {
  register,
  sendVerificationEmail,
  token,
  endsession,
} from '../src/endpoints/identity';
import { changePassword, deleteAccount } from '../src/endpoints/accounts';
import { sendEmailSetup } from '../src/endpoints/two-factor';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/accounts/register/send-verification-email', handler: (p, ctx) => sendVerificationEmail(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/endsession', handler: (p, ctx) => endsession(p, ctx) },
  { method: 'POST', pattern: '/api/accounts/password', handler: (p, ctx) => changePassword(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: (p, ctx) => deleteAccount(p, ctx), auth: true },
  { method: 'DELETE', pattern: '/api/accounts', handler: (p, ctx) => deleteAccount(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/two-factor/send-email', handler: (p, ctx) => sendEmailSetup(p, ctx), auth: true },
  { method: 'GET', pattern: '/api/ciphers', handler: () => ({ statusCode: 200, body: '[]' }), auth: true },
  { method: 'GET', pattern: '/ping', handler: () => ({ statusCode: 200, body: 'pong' }) },
  { method: 'POST', pattern: '/api/ciphers', handler: () => ({ statusCode: 200, body: '{}' }), auth: true },
  { method: 'POST', pattern: '/api/sends/:id/file/:fileId', handler: () => ({ statusCode: 200, body: '{}' }), auth: true },
];

const HASH = Buffer.from('client-side-hash').toString('base64');

function event(
  method: string,
  rawPath: string,
  body = '',
  opts: { contentType?: string; ip?: string; base64?: boolean } = {},
): APIGatewayProxyEventV2 {
  const { contentType = 'application/json', ip = '', base64 } = opts;
  return {
    rawPath,
    body,
    isBase64Encoded: base64,
    headers: { 'content-type': contentType },
    requestContext: { http: { method, sourceIp: ip }, requestId: 'security-test' },
  } as unknown as APIGatewayProxyEventV2;
}

function makeEnv() {
  process.env.SIGNUPS_ALLOWED = 'true';
  const prevSes = process.env.SES_SOURCE;
  delete process.env.SES_SOURCE;
  const store = new MemoryStore();
  const handler = createHandler(routes, { store });
  return {
    store,
    handler,
    restore: () => {
      process.env.SIGNUPS_ALLOWED = 'false';
      if (prevSes === undefined) delete process.env.SES_SOURCE;
      else process.env.SES_SOURCE = prevSes;
    },
  };
}

async function registerUser(handler: ReturnType<typeof createHandler>, email: string, ip = ''): Promise<{ statusCode: number }> {
  return handler(
    event('POST', '/identity/accounts/register', JSON.stringify({
      email,
      masterPasswordAuthentication: { hash: HASH },
      key: 'k',
      keys: { publicKey: 'pub', privateKey: 'priv' },
    }), { ip }),
  );
}

async function login(handler: ReturnType<typeof createHandler>, email: string, ip = '', password = HASH): Promise<{ statusCode: number; body: string }> {
  const form =
    `grant_type=password&username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}` +
    '&scope=api+offline_access&deviceidentifier=dev-1';
  return handler(event('POST', '/identity/connect/token', form, { contentType: 'application/x-www-form-urlencoded', ip }));
}

describe('JWT secret handling (finding #1)', () => {
  afterEach(() => {
    process.env.JWT_SECRET = 'jest-test-secret';
    delete process.env.JWT_SECRET_REF;
  });

  it('refuses to sign when no JWT_SECRET is configured', async () => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_SECRET_REF;
    await expect(signJwt({ sub: 'x' }, 60)).rejects.toThrow(/JWT_SECRET/);
  });

  it('signs with the configured secret (verify the HMAC)', async () => {
    const token = await signJwt({ sub: 'u1' }, 60);
    const [, payload, sig] = token.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const expected = createHmac('sha256', 'jest-test-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(sig).toBe(expected);
  });

  it('has no hardcoded dev secret in source', () => {
    const src = readFileSync('src/crypto.ts', 'utf8');
    expect(src).not.toContain('vaultwarden-cdk-dev-secret');
    expect(src).not.toMatch(/process\.env\.JWT_SECRET\s*\?\?/);
  });
});

describe('request size limits (finding #2)', () => {
  it('rejects API bodies over 1MB with 413', async () => {
    const { handler, restore } = makeEnv();
    const big = 'x'.repeat(1024 * 1024 + 1024);
    const r = await handler(event('POST', '/api/ciphers', Buffer.from(big).toString('base64'), { base64: true }));
    expect(r.statusCode).toBe(413);
    restore();
  });

  it('allows file-upload routes up to 10MB (1MB API cap does not apply)', async () => {
    const { handler, restore } = makeEnv();
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await handler(event('POST', '/api/sends/s1/file/f1', Buffer.from(big).toString('base64'), { base64: true }));
    expect(r.statusCode).not.toBe(413);
    restore();
  });
});

describe('security headers (finding #3)', () => {
  const REQUIRED = [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'X-XSS-Protection',
    'Referrer-Policy',
    'Content-Security-Policy',
  ];

  it.each([
    { name: '200 /ping', path: '/ping', expected: 200 },
    { name: '404 unknown', path: '/nope', expected: 404 },
    { name: '401 unauthenticated', path: '/api/ciphers', expected: 401 },
  ])('present on $name', async ({ path, expected }) => {
    const { handler, restore } = makeEnv();
    const r = await handler(event('GET', path));
    expect(r.statusCode).toBe(expected);
    for (const h of REQUIRED) {
      expect((r.headers as Record<string, string>)[h]).toBeDefined();
    }
    restore();
  });

  it('present on 500 responses', async () => {
    const store = new MemoryStore();
    const throwing = createHandler([
      { method: 'GET', pattern: '/boom', handler: () => { throw new Error('x'); } },
    ], { store });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await throwing(event('GET', '/boom'));
    errSpy.mockRestore();
    expect(r.statusCode).toBe(500);
    for (const h of REQUIRED) expect((r.headers as Record<string, string>)[h]).toBeDefined();
  });
});

describe('open-endpoint rate limits (finding #5)', () => {
  it('caps registrations per IP (5/hour)', async () => {
    const { handler, restore } = makeEnv();
    for (let i = 0; i < 5; i++) {
      const r = await registerUser(handler, `u${i}@test.dev`, '1.2.3.4');
      expect(r.statusCode).toBe(200);
    }
    const sixth = await registerUser(handler, 'u5@test.dev', '1.2.3.4');
    expect(sixth.statusCode).toBe(429);
    restore();
  });

  it('a different IP is not throttled by another IP bucket', async () => {
    const { handler, restore } = makeEnv();
    for (let i = 0; i < 5; i++) await registerUser(handler, `v${i}@test.dev`, '5.6.7.8');
    const r = await registerUser(handler, 'fresh@test.dev', '9.9.9.9');
    expect(r.statusCode).toBe(200);
    restore();
  });
});

describe('input validation (finding #2)', () => {
  it('rejects malformed emails at register and verify', async () => {
    const { handler, restore } = makeEnv();
    const r1 = await handler(event('POST', '/identity/accounts/register', JSON.stringify({ email: 'not-an-email', masterPasswordAuthentication: { hash: HASH } })));
    expect(r1.statusCode).toBe(400);
    const r2 = await handler(event('POST', '/identity/accounts/register/send-verification-email', JSON.stringify({ email: 'a@b' })));
    expect(r2.statusCode).toBe(400);
    restore();
  });
});

describe('no secrets in logs (finding #4)', () => {
  it('email 2FA codes are never logged', async () => {
    const { handler, restore } = makeEnv();
    await registerUser(handler, 'tfa@test.dev');
    const res = await login(handler, 'tfa@test.dev');
    const { access_token } = JSON.parse(res.body);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = {
      ...event('POST', '/api/two-factor/send-email', JSON.stringify({ email: 'tfa@test.dev', masterPasswordHash: HASH })),
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    } as APIGatewayProxyEventV2;
    const r = await handler(req);
    expect(r.statusCode).toBe(200);
    const { code } = JSON.parse(r.body);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain(code);
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain(code);
    logSpy.mockRestore();
    errSpy.mockRestore();
    expect(access_token).toBeTruthy();
    restore();
  });
});

describe('audit trail (finding #7)', () => {
  it('records login success/failure, password change, logout, deletion — no secrets', async () => {
    const { handler, store, restore } = makeEnv();
    await registerUser(handler, 'audit@test.dev');

    const ok = await login(handler, 'audit@test.dev');
    expect(ok.statusCode).toBe(200);
    const { access_token } = JSON.parse(ok.body);
    const auth = { authorization: `Bearer ${access_token}` };

    const bad = await login(handler, 'audit@test.dev', '', Buffer.from('wrong').toString('base64'));
    expect(bad.statusCode).toBe(400);

    const pw = {
      ...event('POST', '/api/accounts/password', JSON.stringify({ masterPasswordHash: HASH, newMasterPasswordHash: HASH })),
      headers: auth,
    } as APIGatewayProxyEventV2;
    expect((await handler(pw)).statusCode).toBe(200);

    // Password change rotates the security stamp, killing the old session:
    // log in again before the delete/logout steps (finding #8 behavior).
    const relogin = await login(handler, 'audit@test.dev');
    expect(relogin.statusCode).toBe(200);
    const ref2 = JSON.parse(relogin.body).refresh_token;
    const auth2 = { authorization: `Bearer ${JSON.parse(relogin.body).access_token}` };

    const del = {
      ...event('POST', '/api/accounts/delete', JSON.stringify({ masterPasswordHash: HASH })),
      headers: auth2,
    } as APIGatewayProxyEventV2;
    expect((await handler(del)).statusCode).toBe(200);

    const out = {
      ...event('POST', '/identity/connect/endsession', `refresh_token=${encodeURIComponent(ref2)}`, { contentType: 'application/x-www-form-urlencoded' }),
    };
    expect((await handler(out)).statusCode).toBe(200);

    const events = store.auditEntries.map((a) => a.event);
    expect(events).toContain('LOGIN_SUCCESS');
    expect(events).toContain('LOGIN_FAILED');
    expect(events).toContain('PASSWORD_CHANGED');
    expect(events).toContain('LOGOUT');
    expect(events).toContain('ACCOUNT_DELETED');

    const trail = store.auditEntries.map((a) => a.details ?? '').join('\n');
    expect(trail).not.toContain(HASH);
    expect(trail).not.toContain('client-side-hash');
    restore();
  });
});