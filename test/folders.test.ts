import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { register, token } from '../src/endpoints/identity';
import { folderList, folderGet, folderCreate, folderUpdate, folderDelete } from '../src/endpoints/folders';
import { cipherCreate } from '../src/endpoints/ciphers';
import { sync } from '../src/endpoints/accounts';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'GET', pattern: '/api/folders', handler: folderList, auth: true },
  { method: 'GET', pattern: '/api/folders/:folderId', handler: folderGet, auth: true },
  { method: 'POST', pattern: '/api/folders', handler: folderCreate, auth: true },
  { method: 'PUT', pattern: '/api/folders/:folderId', handler: folderUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/folders/:folderId', handler: folderDelete, auth: true },
  { method: 'POST', pattern: '/api/ciphers', handler: cipherCreate, auth: true },
  { method: 'GET', pattern: '/api/sync', handler: sync, auth: true },
];

function makeEnv() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function ev(method: string, rawPath: string, body = '', token?: string): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body) headers['content-type'] = body.includes('grant_type') ? 'application/x-www-form-urlencoded' : 'application/json';
  return {
    rawPath,
    body,
    headers,
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

async function seed(env: ReturnType<typeof makeEnv>, email: string): Promise<string> {
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
    ),
  );
  expect(login.statusCode).toBe(200);
  return JSON.parse(login.body as string).access_token as string;
}

describe('folders CRUD', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('create → folder shape; list and get return it; 404 on unknown id', async () => {
    const env = makeEnv();
    const at = await seed(env, 'folders@example.com');
    const created = await env.handler(ev('POST', '/api/folders', JSON.stringify({ name: 'Work' }), at));
    expect(created.statusCode).toBe(200);
    const folder = JSON.parse(created.body as string);
    expect(folder.object).toBe('folder');
    expect(folder.name).toBe('Work');
    expect(folder.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof folder.revisionDate).toBe('string');

    const list = JSON.parse((await env.handler(ev('GET', '/api/folders', '', at))).body as string);
    expect(list.object).toBe('list');
    expect(list.data).toEqual([folder]);

    const get = await env.handler(ev('GET', `/api/folders/${folder.id}`, '', at));
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body as string)).toEqual(folder);

    const miss = await env.handler(ev('GET', '/api/folders/nope', '', at));
    expect(miss.statusCode).toBe(404);
  });

  it('update renames and bumps revisionDate', async () => {
    const env = makeEnv();
    const at = await seed(env, 'rename@example.com');
    const folder = JSON.parse((await env.handler(ev('POST', '/api/folders', JSON.stringify({ name: 'A' }), at))).body as string);
    const updated = await env.handler(ev('PUT', `/api/folders/${folder.id}`, JSON.stringify({ name: 'B' }), at));
    expect(updated.statusCode).toBe(200);
    const body = JSON.parse(updated.body as string);
    expect(body.name).toBe('B');
    // same-millisecond create+update is legitimate — assert monotonicity, not inequality
    expect(new Date(body.revisionDate).getTime()).toBeGreaterThanOrEqual(
      new Date(folder.revisionDate).getTime(),
    );
  });

  it('delete orphans member ciphers (folderId → null) and removes folder row', async () => {
    const env = makeEnv();
    const at = await seed(env, 'orphan@example.com');
    const folder = JSON.parse((await env.handler(ev('POST', '/api/folders', JSON.stringify({ name: 'F' }), at))).body as string);
    const cipher = JSON.parse(
      (
        await env.handler(
          ev('POST', '/api/ciphers', JSON.stringify({ type: 1, name: 'c', folderId: folder.id, login: { username: 'u' } }), at),
        )
      ).body as string,
    );

    const del = await env.handler(ev('DELETE', `/api/folders/${folder.id}`, '', at));
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body as string)).toEqual({});

    const list = JSON.parse((await env.handler(ev('GET', '/api/folders', '', at))).body as string);
    expect(list.data).toEqual([]);
    const miss = await env.handler(ev('GET', `/api/folders/${folder.id}`, '', at));
    expect(miss.statusCode).toBe(404);

    const userId = (await env.store.getUserByEmail('orphan@example.com'))!.id;
    const orphaned = await env.store.getCipher(userId, cipher.id);
    expect(orphaned!.folderId).toBeNull();
  });

  it('sync.folders carries folders', async () => {
    const env = makeEnv();
    const at = await seed(env, 'synced@example.com');
    const folder = JSON.parse((await env.handler(ev('POST', '/api/folders', JSON.stringify({ name: 'Home' }), at))).body as string);
    const syncBody = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(syncBody.folders).toEqual([folder]);
  });

  it('401 without bearer on folder endpoints', async () => {
    const env = makeEnv();
    expect((await env.handler(ev('GET', '/api/folders'))).statusCode).toBe(401);
    expect((await env.handler(ev('POST', '/api/folders', '{}'))).statusCode).toBe(401);
    expect((await env.handler(ev('DELETE', '/api/folders/x'))).statusCode).toBe(401);
  });
});