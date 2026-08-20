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
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/delete', handler: (p, c) => cipherSoftDelete(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/soft-delete', handler: (p, c) => cipherSoftDelete(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/soft-delete', handler: (p, c) => cipherSoftDelete(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/restore', handler: (p, c) => cipherRestore(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/restore', handler: (p, c) => cipherRestore(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/restore', handler: (p, c) => cipherBulkRestore(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/restore', handler: (p, c) => cipherBulkRestore(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/archive', handler: (p, c) => cipherArchive(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/:cipherId/unarchive', handler: (p, c) => cipherUnarchive(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/archive', handler: (p, c) => cipherBulkArchive(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/unarchive', handler: (p, c) => cipherBulkUnarchive(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/move', handler: (p, c) => cipherMove(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/purge', handler: (p, c) => cipherPurge(p, c), auth: true },
  { method: 'POST', pattern: '/api/ciphers/delete', handler: (p, c) => cipherBulkDelete(p, c), auth: true },
  { method: 'PUT', pattern: '/api/ciphers/delete', handler: (p, c) => cipherBulkSoftDelete(p, c), auth: true },
  { method: 'DELETE', pattern: '/api/ciphers', handler: (p, c) => cipherBulkDelete(p, c), auth: true },
  { method: 'GET', pattern: '/api/sync', handler: (p, c) => sync(p, c), auth: true },
];

import {
  cipherList,
  cipherGet,
  cipherCreate,
  cipherUpdate,
  cipherPartial,
  cipherDelete,
  cipherSoftDelete,
  cipherRestore,
  cipherArchive,
  cipherUnarchive,
  cipherBulkArchive,
  cipherBulkUnarchive,
  cipherBulkRestore,
  cipherMove,
  cipherPurge,
  cipherBulkDelete,
  cipherBulkSoftDelete,
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

  it('create with nested cipher body — capitalized Android keys (Cipher/CollectionIds) keeps the cipher', async () => {
    const env = makeEnv();
    const at = await seed(env, 'nested@example.com');
    const body = { Cipher: { ...LOGIN_CIPHER, name: 'nested-name' }, CollectionIds: [] };
    const r = await env.handler(ev('POST', '/api/ciphers/create', JSON.stringify(body), at));
    expect(r.statusCode).toBe(200);
    const parsed = JSON.parse(r.body as string);
    expect(parsed.name).toBe('nested-name');
    expect(parsed.type).toBe(1);
    expect(parsed.login.username).toBe('alice@example.com');
    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe('nested-name');
  });

  it('create with nested lowercase cipher key still works', async () => {
    const env = makeEnv();
    const at = await seed(env, 'nested2@example.com');
    const body = { cipher: { ...LOGIN_CIPHER, name: 'nested-lower' }, collectionIds: [] };
    const r = await env.handler(ev('POST', '/api/ciphers/create', JSON.stringify(body), at));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body as string).name).toBe('nested-lower');
  });

  it('accepts empty/garbage payloads (200) but never serves type-0 rows to sync/list', async () => {
    const env = makeEnv();
    const at = await seed(env, 'type0@example.com');
    const r = await env.handler(ev('POST', '/api/ciphers/create', JSON.stringify({ cipher: {}, collectionIds: [] }), at));
    expect(r.statusCode).toBe(200);
    const r2 = await env.handler(ev('POST', '/api/ciphers', JSON.stringify({ type: 0, name: '' }), at));
    expect(r2.statusCode).toBe(200);
    const sync = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(sync.ciphers).toHaveLength(0);
    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.data).toHaveLength(0);
  });

  it('sync and list filter out legacy type-0 rows', async () => {
    const env = makeEnv();
    const at = await seed(env, 'filter0@example.com');
    const userId = (await env.store.getUserByEmail('filter0@example.com'))!.id;
    const now = new Date().toISOString();
    await env.store.putCipher({
      pk: `CIPHER#${userId}#legacy-blank`,
      sk: 'CIPHER',
      id: 'legacy-blank',
      owner: userId,
      type: 0,
      name: '',
      notes: null,
      favorite: false,
      reprompt: 0,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      creationDate: now,
      revisionDate: now,
      deletedDate: null,
      archivedDate: null,
      key: null,
      login: null,
      secureNote: null,
      card: null,
      identity: null,
      sshKey: null,
      bankAccount: null,
      driversLicense: null,
      passport: null,
      fields: null,
      passwordHistory: null,
      attachments: null,
    } as any);
    const sync = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(sync.ciphers.filter((c: any) => c.id === 'legacy-blank')).toHaveLength(0);
    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.data.filter((c: any) => c.id === 'legacy-blank')).toHaveLength(0);
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

    // Mobile apps trash via PUT /{id}/delete (soft), the path that made the
    // Android Delete action 404.
    const mobileDel = await env.handler(ev('PUT', `/api/ciphers/${cid}/delete`, '', at));
    expect(mobileDel.statusCode).toBe(200);
    expect((await env.store.getCipher((await env.store.getUserByEmail('trash@example.com'))!.id, cid))!.deletedDate).not.toBeNull();

    // DELETE = permanent (Bitwarden spec), unlike the trashing soft-delete.
    const hard = await env.handler(ev('DELETE', `/api/ciphers/${cid}`, '', at));
    expect(hard.statusCode).toBe(200);
    const uid = (await env.store.getUserByEmail('trash@example.com'))!.id;
    expect(await env.store.getCipher(uid, cid)).toBeNull();
  });

  it('archive/unarchive: archivedDate set/null, stays in list and sync', async () => {
    const env = makeEnv();
    const at = await seed(env, 'archive@example.com');
    const c1 = JSON.parse((await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string).id;
    const c2 = JSON.parse((await env.handler(ev('POST', '/api/ciphers', JSON.stringify({ ...LOGIN_CIPHER, name: 'two' }), at))).body as string).id;
    const userId = (await env.store.getUserByEmail('archive@example.com'))!.id;

    const archived = JSON.parse((await env.handler(ev('PUT', `/api/ciphers/${c1}/archive`, '', at))).body as string);
    expect(archived.statusCode ?? 200).toBe(200);
    expect(archived.archivedDate).not.toBeNull();
    expect(await env.store.getCipher(userId, c1)).toMatchObject({ archivedDate: expect.any(String) });

    const unarchived = JSON.parse((await env.handler(ev('PUT', `/api/ciphers/${c1}/unarchive`, '', at))).body as string);
    expect(unarchived.statusCode ?? 200).toBe(200);
    expect(unarchived.archivedDate).toBeNull();

    const bulk = await env.handler(ev('PUT', '/api/ciphers/archive', JSON.stringify({ ids: [c1, c2] }), at));
    expect(bulk.statusCode).toBe(200);
    const bulkBody = JSON.parse(bulk.body as string);
    expect(bulkBody.object).toBe('list');
    expect(bulkBody.continuationToken).toBeNull();
    expect(bulkBody.data.map((c: { id: string }) => c.id).sort()).toEqual([c1, c2].sort());
    expect(bulkBody.data.every((c: { archivedDate: string | null }) => c.archivedDate !== null)).toBe(true);

    const list = JSON.parse((await env.handler(ev('GET', '/api/ciphers', '', at))).body as string);
    expect(list.data).toHaveLength(2);
    expect(list.data.every((c: { archivedDate: string | null }) => c.archivedDate !== null)).toBe(true);

    const syncBody = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(syncBody.ciphers).toHaveLength(2);
    expect(syncBody.ciphers.every((c: { archivedDate: string | null }) => c.archivedDate !== null)).toBe(true);
  });

it('move sets folderId; PUT bulk delete soft-trashes, POST/DELETE bulk remove permanently', async () => {
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

    // PUT /api/ciphers/delete = mobile soft-delete alias → trash, restorable.
    const soft = await env.handler(ev('PUT', '/api/ciphers/delete', JSON.stringify({ ids: [c1, c2] }), at));
    expect(soft.statusCode).toBe(200);
    expect(await env.store.getCipher(userId, c1)).toMatchObject({ deletedDate: expect.any(String) });
    expect(await env.store.getCipher(userId, c2)).toMatchObject({ deletedDate: expect.any(String) });

    const restore = await env.handler(ev('POST', '/api/ciphers/restore', JSON.stringify({ ids: [c1, c2] }), at));
    expect(restore.statusCode).toBe(200);
    expect((await env.store.getCipher(userId, c1))!.deletedDate).toBeNull();

    // DELETE /api/ciphers (bulk) = permanent, like POST /api/ciphers/delete.
    const bulkDel = await env.handler(ev('DELETE', '/api/ciphers', JSON.stringify({ ids: [c1, c2] }), at));
    expect(bulkDel.statusCode).toBe(200);
    expect(await env.store.getCipher(userId, c1)).toBeNull();
    expect(await env.store.getCipher(userId, c2)).toBeNull();

    // POST remains the permanent bulk path.
    const c3 = JSON.parse((await env.handler(ev('POST', '/api/ciphers', JSON.stringify(LOGIN_CIPHER), at))).body as string).id;
    const postDel = await env.handler(ev('POST', '/api/ciphers/delete', JSON.stringify({ ids: [c3] }), at));
    expect(postDel.statusCode).toBe(200);
    expect(await env.store.getCipher(userId, c3)).toBeNull();
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