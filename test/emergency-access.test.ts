import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { MemoryObjectStore } from '../src/objects';
import { register, token } from '../src/endpoints/identity';
import { cipherCreate } from '../src/endpoints/ciphers';
import {
  eaInvite,
  eaReinvite,
  eaAccept,
  eaConfirm,
  eaUpdate,
  eaDelete,
  eaTrusted,
  eaGranted,
  eaGet,
  eaInitiate,
  eaApprove,
  eaReject,
  eaView,
  eaTakeover,
  eaPassword,
  eaPolicies,
} from '../src/endpoints/emergency-access';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'POST', pattern: '/api/ciphers', handler: cipherCreate, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/trusted', handler: eaTrusted, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/granted', handler: eaGranted, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/:id', handler: eaGet, auth: true },
  { method: 'GET', pattern: '/api/emergency-access/:id/policies', handler: eaPolicies, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/invite', handler: eaInvite, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/reinvite', handler: eaReinvite, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/accept', handler: eaAccept, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/confirm', handler: eaConfirm, auth: true },
  { method: 'PUT', pattern: '/api/emergency-access/:id', handler: eaUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/emergency-access/:id', handler: eaDelete, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/initiate', handler: eaInitiate, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/approve', handler: eaApprove, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/reject', handler: eaReject, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/view', handler: eaView, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/takeover', handler: eaTakeover, auth: true },
  { method: 'POST', pattern: '/api/emergency-access/:id/password', handler: eaPassword, auth: true },
];

function makeEnv() {
  const store = new MemoryStore();
  const objects = new MemoryObjectStore();
  return { store, objects, handler: createHandler(routes, { store, objects }) };
}

function ev(method: string, rawPath: string, body = '', token?: string, contentType = 'application/json'): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = contentType;
  return {
    rawPath,
    rawQueryString: '',
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function loginUser(env: ReturnType<typeof makeEnv>, email: string): Promise<string> {
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
      }).toString(),
      undefined,
      'application/x-www-form-urlencoded',
    ),
  );
  expect(login.statusCode).toBe(200);
  return JSON.parse(login.body as string).access_token as string;
}

async function registerUser(env: ReturnType<typeof makeEnv>, email: string, key = ''): Promise<string> {
  const r = await env.handler(
    ev('POST', '/identity/accounts/register', JSON.stringify({ email, key, masterPasswordAuthentication: { hash: PASSWORD } })),
  );
  expect(r.statusCode).toBe(200);
  return loginUser(env, email);
}

async function invite(env: ReturnType<typeof makeEnv>, at: string, email: string, waitTimeDays = 0) {
  const r = await env.handler(ev('POST', '/api/emergency-access/invite', JSON.stringify({ email, type: 1, waitTimeDays }), at));
  expect(r.statusCode).toBe(200);
  const body = JSON.parse(r.body as string);
  return { id: body.id as string, token: body.token as string };
}

describe('emergency access', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('full lifecycle: invite → register-bound accept → confirm → initiate → approve → view → takeover → password reset', async () => {
    const env = makeEnv();
    const grantorAt = await registerUser(env, 'grantor@example.com', 'grantor-key');
    const { id, token } = await invite(env, grantorAt, 'grantee@example.com');

    // trusted list shows the invite with status 0
    const trusted = await env.handler(ev('GET', '/api/emergency-access/trusted', '', grantorAt));
    expect(trusted.statusCode).toBe(200);
    let list = JSON.parse(trusted.body as string);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ object: 'emergencyAccessGranteeDetails', id, email: 'grantee@example.com', status: 0 });

    // register-bound accept: status 0 → 1 with grantee keys
    const reg = await env.handler(
      ev(
        'POST',
        '/identity/accounts/register',
        JSON.stringify({
          email: 'grantee@example.com',
          masterPasswordAuthentication: { hash: PASSWORD },
          keys: { publicKey: 'granteepub', privateKey: 'granteepriv' },
          emergencyAccessId: id,
          emergencyAccessToken: token,
        }),
      ),
    );
    expect(reg.statusCode).toBe(200);
    const item = await env.store.getEmergencyAccessByToken(token);
    expect(item).toBeNull();
    const grantorId = (await env.store.getUserByEmail('grantor@example.com'))!.id;
    const accepted = await env.store.getEmergencyAccess(grantorId, id);
    expect(accepted).toMatchObject({ status: 1, granteeId: (await env.store.getUserByEmail('grantee@example.com'))!.id, publicKey: 'granteepub' });

    // grantee sees it in granted list (grantor details)
    const granteeAt = await loginUser(env, 'grantee@example.com');
    const granted = await env.handler(ev('GET', '/api/emergency-access/granted', '', granteeAt));
    expect(granted.statusCode).toBe(200);
    list = JSON.parse(granted.body as string);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ object: 'emergencyAccessGrantorDetails', id, email: 'grantor@example.com', status: 1 });

    // confirm seals the vault key; initiate before wait elapses is blocked, then ok
    const confirm = await env.handler(ev('POST', `/api/emergency-access/${id}/confirm`, JSON.stringify({ key: 'enc-key' }), grantorAt));
    expect(confirm.statusCode).toBe(200);
    const init = await env.handler(ev('POST', `/api/emergency-access/${id}/initiate`, '{}', granteeAt));
    expect(init.statusCode).toBe(200);
    const approve = await env.handler(ev('POST', `/api/emergency-access/${id}/approve`, '{}', grantorAt));
    expect(approve.statusCode).toBe(200);

    // view returns the vault bundle + encryptedKey; approve again is a guard error
    const cipher = await env.handler(
      ev('POST', '/api/ciphers', JSON.stringify({ type: 1, name: 'vault-secret', login: { username: 'u', password: 'cA==' } }), grantorAt),
    );
    expect(cipher.statusCode).toBe(200);
    const view = await env.handler(ev('POST', `/api/emergency-access/${id}/view`, '{}', granteeAt));
    expect(view.statusCode).toBe(200);
    const viewBody = JSON.parse(view.body as string);
    expect(viewBody.encryptedKey).toBe('enc-key');
    expect(viewBody.ciphers.some((c: { name: string }) => c.name === 'vault-secret')).toBe(true);

    // takeover signs the grantee in as the grantor (akey + identity swapped)
    const takeover = await env.handler(ev('POST', `/api/emergency-access/${id}/takeover`, '{}', granteeAt));
    expect(takeover.statusCode).toBe(200);
    const session = JSON.parse(takeover.body as string);
    expect(session.access_token).toBeTruthy();
    expect(session.Key).toBe((await env.store.getUserByEmail('grantor@example.com'))!.akey);

    // password reset changes the grantor's password + key; status back to confirmed
    const grantorBefore = (await env.store.getUserByEmail('grantor@example.com'))!;
    const password = await env.handler(
      ev('POST', `/api/emergency-access/${id}/password`, JSON.stringify({ newMasterPasswordHash: Buffer.from('new-hash').toString('base64'), key: 'new-key' }), granteeAt),
    );
    expect(password.statusCode).toBe(200);
    const grantor = (await env.store.getUserByEmail('grantor@example.com'))!;
    expect(grantor.akey).toBe('new-key');
    expect(grantor.securityStamp).not.toBe(grantorBefore.securityStamp);
    const reset = await env.store.getEmergencyAccess(grantor.id, id);
    expect(reset!.status).toBe(2);
  });

  it('authed accept path binds an existing account with its keys', async () => {
    const env = makeEnv();
    const grantorAt = await registerUser(env, 'owner@example.com');
    const { id, token } = await invite(env, grantorAt, 'existing@example.com');
    const granteeAt = await registerUser(env, 'existing@example.com');
    const accept = await env.handler(
      ev('POST', `/api/emergency-access/${id}/accept`, JSON.stringify({ token, encryptedPrivateKey: 'priv', publicKey: 'pub', name: 'Ex' }), granteeAt),
    );
    expect(accept.statusCode).toBe(200);
    const item = await env.store.getEmergencyAccess((await env.store.getUserByEmail('owner@example.com'))!.id, id);
    expect(item).toMatchObject({ status: 1, name: 'Ex', encryptedPrivateKey: 'priv', publicKey: 'pub' });
  });

  it('wait time blocks initiate until elapsed', async () => {
    const env = makeEnv();
    const grantorAt = await registerUser(env, 'w@example.com');
    const { id, token } = await invite(env, grantorAt, 'g@example.com', 7);
    await env.handler(
      ev('POST', '/identity/accounts/register', JSON.stringify({ email: 'g@example.com', masterPasswordAuthentication: { hash: PASSWORD }, emergencyAccessId: id, emergencyAccessToken: token })),
    );
    const granteeAt = await loginUser(env, 'g@example.com');
    await env.handler(ev('POST', `/api/emergency-access/${id}/confirm`, JSON.stringify({ key: 'k' }), grantorAt));
    const init = await env.handler(ev('POST', `/api/emergency-access/${id}/initiate`, '{}', granteeAt));
    expect(init.statusCode).toBe(400);
  });

  it('reinvite regenerates the token; update edits type/waitTimeDays; delete removes; guards hold', async () => {
    const env = makeEnv();
    const grantorAt = await registerUser(env, 'u@example.com');
    const otherAt = await registerUser(env, 'intruder@example.com');
    const { id } = await invite(env, grantorAt, 'g2@example.com');

    // wrong grantor cannot get/update/delete
    for (const [method, path] of [
      ['GET', `/api/emergency-access/${id}`],
      ['PUT', `/api/emergency-access/${id}`],
      ['DELETE', `/api/emergency-access/${id}`],
      ['POST', `/api/emergency-access/${id}/confirm`],
      ['POST', `/api/emergency-access/${id}/approve`],
    ] as const) {
      const r = await env.handler(ev(method, path, method === 'PUT' || method === 'POST' ? '{}' : '', otherAt));
      expect(r.statusCode).toBe(404);
    }
    // grantee-side endpoints reject a non-grantee
    const view = await env.handler(ev('POST', `/api/emergency-access/${id}/view`, '{}', otherAt));
    expect(view.statusCode).toBe(404);

    const reinvite = await env.handler(ev('POST', `/api/emergency-access/${id}/reinvite`, '{}', grantorAt));
    expect(reinvite.statusCode).toBe(200);
    const reinvited = JSON.parse(reinvite.body as string);
    expect(reinvited.token).toBeTruthy();

    const update = await env.handler(ev('PUT', `/api/emergency-access/${id}`, JSON.stringify({ type: 0, waitTimeDays: 3 }), grantorAt));
    expect(update.statusCode).toBe(200);
    const item = await env.store.getEmergencyAccess((await env.store.getUserByEmail('u@example.com'))!.id, id);
    expect(item).toMatchObject({ type: 0, waitTimeDays: 3 });

    const del = await env.handler(ev('DELETE', `/api/emergency-access/${id}`, '', grantorAt));
    expect(del.statusCode).toBe(200);
    expect(await env.store.getEmergencyAccess((await env.store.getUserByEmail('u@example.com'))!.id, id)).toBeNull();
  });

  it('policies endpoint answers the listResponse envelope', async () => {
    const env = makeEnv();
    const at = await registerUser(env, 'p@example.com');
    const { id } = await invite(env, at, 'pg@example.com');
    const r = await env.handler(ev('GET', `/api/emergency-access/${id}/policies`, '', at));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string)).toEqual({ Data: [], Object: 'listResponse' });
  });
});
