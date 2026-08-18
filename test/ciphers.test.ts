import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { register, token } from '../src/endpoints/identity';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'GET', pattern: '/api/ciphers', handler: (p, c) => cipherList(p, c), auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId', handler: (p, c) => cipherGet(p, c), auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId/details', handler: (p, c) => cipherGet(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers', handler: (p, c) => cipherCreate(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/create', handler: (p, c) => cipherCreate(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId', handler: (p, c) => cipherUpdate(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId', handler: (p, c) => cipherUpdate(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/partial', handler: (p, c) => cipherPartial(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/partial', handler: (p, c) => cipherPartial(p, c), auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId', handler: (p, c) => cipherDelete(p, c), auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId/delete', handler: (p, c) => cipherDelete(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/delete', handler: (p, c) => cipherDelete(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/restore', handler: (p, c) => cipherRestore(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/restore', handler: (p, c) => cipherRestore(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/move', handler: (p, c) => cipherMove(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/purge', handler: (p, c) => cipherPurge(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/delete', handler: (p, c) => cipherBulkDelete(p, c), auth: true },
  { method: 'GET', pattern: '/api/sync', handler: (p, c) => sync(p, c), auth: true },
];

import {
  cipherList,
  cipherGet,
  cipherCreate,
  cipherUpdate,
  cipherPartial,
  cipherDelete,
  cipherRestore,
  cipherMove,
  cipherPurge,
  cipherBulkDelete,
} from '../src/endpoints/ciphers';
import { sync } from '../src/endpoints/accounts';

function makeEnv() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function ev(method: string, rawPath: string, body = '', token?: string, contentType = 'application/json'): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = contentType;
  return {
    rawPath,
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function seed(env: ReturnType<typeof makeEnv>, email: string) {
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
        deviceIdentifier: 'dev-1',
      }).toString(),
      undefined,
      'application/x-www-form-urlencoded',
    ),
  );
  return JSON.parse((login as any).body as string).access_token as string;
}

const LOGIN_CIPHER = {
  type: 1,
  name: 'example.com',
  notes: 'my notes',
  favorite: true,
  login: {
    uris: [{ uri: 'https://example.com', match: 0 }, { uri: 'https://example.org', match: null }],
    username: 'alice@example.com',
    password: '2.encrypted!password-string',
    totp: 'totp-key',
  },
  fields: [{ name: 'custom', value: 'v', type: 0, linkedId: null }],
};

describe('cipher CRUD', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('creates a login cipher — canonical shape, encrypted strings verbatim', async () => {
    const env = makeEnv();
    const at = await seed(env, 'create@example.com');
    const r = await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.object).toBe('cipher');
    expect(body.type).toBe(1);
    expect(body.name).toBe('example.com');
    expect(body.login).toEqual({
      uris: [
        { uri: 'https://example.com', match: 0 },
        { uri: 'https://example.org', match: null },
      ],
      username: 'alice@example.com',
      password: '2.encrypted!password-string',
      totp: 'totp-key',
      passwordRevisionDate: null,
      fido2Credentials: null,
    });
    expect(body.secureNote).toBeNull();
    expect(body.card).toBeNull();
    expect(body.identity).toBeNull();
    expect(body.bankAccount).toBeNull();
    expect(body.driversLicense).toBeNull();
    expect(body.passport).toBeNull();
    expect(body.folderId).toBeNull();
    expect(body.fields).toEqual([{ name: 'custom', value: 'v', type: 0, linkedId: null }]);
    expect(body.deletedDate).toBeNull();
    expect(body.attachments).toBeNull();
    expect(body.reprompt).toBe(0);
    expect(body.edit).toBe(true);
    expect(body.viewPassword).toBe(true);
    expect(body.organizationUseTotp).toBe(true);
    return body.id as string;
  });

  it('accepts unknown fields on create (never rejects extras)', async () => {
    const env = makeEnv();
    const at = await seed(env, 'extra@example.com');
    const body = { ...LOGIN_CIPHER, unknownField: 'ignored', another: { nested: true } };
    const r = await env.handler(ev('POST', '/api/ciphers', JSON.stringify(body), at));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string).name).toBe('example.com');
  });

  it('creates all four core types with the right type payload', async () => {
    const env = makeEnv();
    const at = await seed(env, 'types@example.com');
    const cases: Array<[number, string, Record<string, unknown>]> = [
      [1, 'login', { login: { username: 'u' }, name: 'l' }],
      [2, 'secureNote', { secureNote: { type: 0 }, name: 'n' }],
      [3, 'card', { card: { cardholderName: 'n', number: '4111', brand: 'Visa' }, name: 'c' }],
      [4, 'identity', { identity: { firstName: 'f', lastName: 'l' }, name: 'i' }],
    ];
    for (const [type, key, payload] of cases) {
      const r = await env.handler(ev('POST', '/api/ciphers', JSON.stringify({ ...payload, type }), at));
      const body = JSON.parse(r.body as string);
      expect(body.type).toBe(type);
      for (const k of ['login', 'secureNote', 'card', 'identity']) {
        if (k === key) expect(body[k]).not.toBeNull();
        else expect(body[k]).toBeNull();
      }
    }
  });

  it('get/details/list return cipherDetails shape; list excludes deleted', async () => {
    const env = makeEnv();
    const at = await seed(env, 'read@example.com');
    const created = JSON.parse(
      (await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string,
    );
    const cid = created.id;

    const get = await env.handler(ev('GET', `/api/ciphers/${cid}`, '', at));
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body as string).object).toBe('cipherDetails');

    const details = await env.handler(ev('GET', `/api/ciphers/${cid}/details`, '', at));
    expect(JSON.parse(details.body as string).object).toBe('cipherDetails');

    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.object).toBe('list');
    expect(list.continuationToken).toBeNull();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].object).toBe('cipherDetails');
    expect(list.data[0].id).toBe(cid);
  });

  it('update replaces fields; partial merges only login fields (autofill)', async () => {
    const env = makeEnv();
    const at = await seed(env, 'update@example.com');
    const created = JSON.parse(
      (await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string,
    );
    const cid = created.id;

    const replaced = await env.handler(
      ev('PUT', `/api/ciphers/${cid}`, JSON.stringify({ type: 1, name: 'renamed', login: { username: 'new-user' } }), at),
    );
    expect(replaced.statusCode).toBe(200);
    let body = JSON.parse(replaced.body as string);
    expect(body.name).toBe('renamed');
    expect(body.login.username).toBe('new-user');
    expect(body.login.password).toBeNull();

    const partial = await env.handler(
      ev('PUT', `/api/ciphers/${cid}/partial`, JSON.stringify({ login: { password: 'new-pass' } }), at),
    );
    expect(partial.statusCode).toBe(200);
    body = JSON.parse(partial.body as string);
    expect(body.login.password).toBe('new-pass');
    expect(body.login.username).toBe('new-user');
    expect(body.name).toBe('renamed');
  });

  it('soft-delete → trash semantics: excluded from list, present in sync with deletedDate; restore brings it back', async () => {
    const env = makeEnv();
    const at = await seed(env, 'trash@example.com');
    const created = JSON.parse(
      (await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string,
    );
    const cid = created.id;

    const del = await env.handler(ev('PUT', `/api/ciphers/${cid}/soft-delete`, '', at));
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body as string)).toEqual({});

    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.data).toHaveLength(0);

    const syncBody = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(syncBody.ciphers).toHaveLength(1);
    expect(syncBody.ciphers[0].deletedDate).not.toBeNull();

    const restore = await env.handler(ev('POST', `/api/ciphers/${cid}/restore`, '', at));
    expect(restore.statusCode).toBe(200);
    const after = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(after.data).toHaveLength(1);
    expect(after.data[0].deletedDate).toBeNull();

    // DELETE = permanent (Bitwarden spec), unlike the trashing soft-delete.
    const hard = await env.handler(ev('DELETE', `/api/ciphers/${cid}`, '', at));
    expect(hard.statusCode).toBe(200);
    const uid = (await env.store.getUserByEmail('trash@example.com'))!.id;
    expect(await env.store.getCipher(uid, cid)).toBeNull();
  });

it('move sets folderId; bulk delete removes rows permanently', async () => {
    const env = makeEnv();
    const at = await seed(env, 'lifecycle@example.com');
    const c1 = JSON.parse((await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string).id;
    const c2 = JSON.parse((await env.handler(ev('POST', '/api/ciphers', JSON.stringify({ ...LOGIN_CIPHER, name: 'two' }), at))).body as string).id;

    const move = await env.handler(
      ev('POST', '/api/ciphers/move', JSON.stringify({ folderId: 'folder-1', ids: [c1, c2] }), at),
    );
    expect(move.statusCode).toBe(200);
    const userId = (await env.store.getUserByEmail('lifecycle@example.com'))!.id;
    const afterMove = await env.store.getCipher(userId, c1);
    expect(afterMove!.folderId).toBe('folder-1');

    const bulkDel = await env.handler(ev('POST', '/api/ciphers/delete', JSON.stringify({ ids: [c1, c2] }), at));
    expect(bulkDel.statusCode).toBe(200);
    const uid = (await env.store.getUserByEmail('lifecycle@example.com'))!.id;
    expect(await env.store.getCipher(uid, c1)).toBeNull();
    expect(await env.store.getCipher(uid, c2)).toBeNull();
  });

  it('404 on a foreign/unknown cipher id; 401 without bearer', async () => {
    const env = makeEnv();
    const at = await seed(env, 'owner@example.com');
    await seed(env, 'other@example.com');
    const foreign = await env.handler(ev('GET', '/api/ciphers/some-id', '', at));
    expect(foreign.statusCode).toBe(404);
    expect(JSON.parse(foreign.body as string).Message).toBe('Not found.');

    const anon = await env.handler(ev('GET', '/api/ciphers'));
    expect(anon.statusCode).toBe(401);
  });
});