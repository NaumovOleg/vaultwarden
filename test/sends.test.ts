import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { MemoryObjectStore } from '../src/objects';
import { register, token } from '../src/endpoints/identity';
import {
  sendList,
  sendGet,
  sendCreate,
  sendUpdate,
  sendDelete,
  sendRemovePassword,
  sendFileV2,
  sendFileUpload,
  sendAccess,
  sendFileDownload,
} from '../src/endpoints/sends';
import { sync } from '../src/endpoints/accounts';
import { deleteAccount } from '../src/endpoints/accounts';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'GET', pattern: '/api/sync', handler: sync, auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
  { method: 'GET', pattern: '/api/sends', handler: sendList, auth: true },
  { method: 'GET', pattern: '/api/sends/:id', handler: sendGet, auth: true },
  { method: 'POST', pattern: '/api/sends', handler: sendCreate, auth: true },
  { method: 'PUT', pattern: '/api/sends/:id', handler: sendUpdate, auth: true },
  { method: 'DELETE', pattern: '/api/sends/:id', handler: sendDelete, auth: true },
  { method: 'POST', pattern: '/api/sends/:id/delete', handler: sendDelete, auth: true },
  { method: 'PUT', pattern: '/api/sends/:id/remove-password', handler: sendRemovePassword, auth: true },
  { method: 'POST', pattern: '/api/sends/file/v2', handler: sendFileV2, auth: true },
  { method: 'POST', pattern: '/api/sends/:id/file/:fileId', handler: sendFileUpload, auth: true },
  { method: 'POST', pattern: '/api/sends/access/:accessId', handler: sendAccess },
  { method: 'GET', pattern: '/api/sends/:accessId/file/:fileId', handler: sendFileDownload },
];

function makeEnv() {
  const store = new MemoryStore();
  const objects = new MemoryObjectStore();
  return { store, objects, handler: createHandler(routes, { store, objects }) };
}

function ev(
  method: string,
  rawPath: string,
  body = '',
  token?: string,
  contentType = 'application/json',
): APIGatewayProxyEventV2 {
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

function multipartBody(fields: Record<string, string | Buffer>): { body: string; contentType: string } {
  const boundary = '----sende2e';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;
    const content = Buffer.isBuffer(value) ? value.toString('latin1') : value;
    parts.push(head + content + '\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(''), contentType: `multipart/form-data; boundary=${boundary}` };
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
      'application/x-www-form-urlencoded',
    ),
  );
  expect(login.statusCode).toBe(200);
  return JSON.parse(login.body as string).access_token as string;
}

describe('sends', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('text send CRUD roundtrip: create → list/get → update → remove-password → delete', async () => {
    const env = makeEnv();
    const at = await seed(env, 'send@example.com');

    const created = await env.handler(
      ev(
        'POST',
        '/api/sends',
        JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', type: 0, name: 'my secret', text: { text: 'encrypted payload', hidden: true }, password: 'pw', maxAccessCount: 5 }),
        at,
      ),
    );
    expect(created.statusCode).toBe(200);
    const send = JSON.parse(created.body as string);
    expect(send.object).toBe('send');
    expect(send.accessId).toMatch(/^[0-9a-f]{10}$/);
    expect(send.passwordProtected).toBe(true);
    expect(send.type).toBe(0);
    expect(send.text.text).toBe('encrypted payload');
    expect(send.accessCount).toBe(0);
    expect(JSON.stringify(send)).not.toContain('pw');

    const listed = JSON.parse((await env.handler(ev('GET', '/api/sends', '', at))).body as string);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(send.id);

    const got = JSON.parse((await env.handler(ev('GET', `/api/sends/${send.id}`, '', at))).body as string);
    expect(got.name).toBe('my secret');

    const updated = await env.handler(
      ev('PUT', `/api/sends/${send.id}`, JSON.stringify({ name: 'renamed', text: { text: 'new payload', hidden: false } }), at),
    );
    expect(updated.statusCode).toBe(200);
    const upd = JSON.parse(updated.body as string);
    expect(upd.name).toBe('renamed');
    expect(upd.passwordProtected).toBe(true); // password preserved on partial update

    const removed = await env.handler(ev('PUT', `/api/sends/${send.id}/remove-password`, '', at));
    expect(removed.statusCode).toBe(200);
    const noPw = JSON.parse((await env.handler(ev('GET', `/api/sends/${send.id}`, '', at))).body as string);
    expect(noPw.passwordProtected).toBe(false);

    const del = await env.handler(ev('DELETE', `/api/sends/${send.id}`, '', at));
    expect(del.statusCode).toBe(200);
    expect((await env.handler(ev('GET', `/api/sends/${send.id}`, '', at))).statusCode).toBe(404);
  });

  it('anonymous access: wrong password → 400 passwordRequired; right → sendAccess with data; count honors maxAccessCount', async () => {
    const env = makeEnv();
    const at = await seed(env, 'gate@example.com');
    const created = JSON.parse(
      (
        await env.handler(
          ev(
            'POST',
            '/api/sends',
            JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', type: 0, name: 'gated', text: { text: 'secret text', hidden: false }, password: 'letmein', maxAccessCount: 1 }),
            at,
          ),
        )
      ).body as string,
    );
    const { accessId } = created;
    void at;

    const noPw = await env.handler(ev('POST', `/api/sends/access/${accessId}`, JSON.stringify({})));
    expect(noPw.statusCode).toBe(400);
    expect(JSON.parse(noPw.body as string).ModelState.passwordRequired).toBeDefined();

    const badPw = await env.handler(ev('POST', `/api/sends/access/${accessId}`, JSON.stringify({ password: 'nope' })));
    expect(badPw.statusCode).toBe(400);

    const ok = await env.handler(ev('POST', `/api/sends/access/${accessId}`, JSON.stringify({ password: 'letmein' })));
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body as string);
    expect(body.object).toBe('sendAccess');
    expect(body.data.text.text).toBe('secret text');
    expect(body.passwordProtected).toBe(true);

    const exceeded = await env.handler(ev('POST', `/api/sends/access/${accessId}`, JSON.stringify({ password: 'letmein' })));
    expect(exceeded.statusCode).toBe(400);
  });

  it('deletionDate-past and disabled sends are 404 for anonymous + hidden from list', async () => {
    const env = makeEnv();
    const at = await seed(env, 'expire@example.com');
    const created = JSON.parse(
      (
        await env.handler(
          ev(
            'POST',
            '/api/sends',
            JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', type: 0, name: 'gone', text: { text: 'x', hidden: false }, deletionDate: new Date(Date.now() - 1000).toISOString() }),
            at,
          ),
        )
      ).body as string,
    );
    expect((await env.handler(ev('POST', `/api/sends/access/${created.accessId}`, JSON.stringify({})))).statusCode).toBe(404);
    expect(JSON.parse((await env.handler(ev('GET', '/api/sends', '', at))).body as string)).toHaveLength(0);

    await env.handler(
      ev('PUT', `/api/sends/${created.id}`, JSON.stringify({ disabled: true, deletionDate: null }), at),
    );
    expect((await env.handler(ev('POST', `/api/sends/access/${created.accessId}`, JSON.stringify({})))).statusCode).toBe(404);
    expect(JSON.parse((await env.handler(ev('GET', '/api/sends', '', at))).body as string)).toHaveLength(0);
  });

  it('file send: v2 → multipart upload → anonymous access → 302 download with byte-identical data', async () => {
    const env = makeEnv();
    const at = await seed(env, 'filesend@example.com');

    const created = await env.handler(
      ev('POST', '/api/sends/file/v2', JSON.stringify({ key: 'send-key', fileName: 'report.pdf', fileSize: 12 }), at),
    );
    expect(created.statusCode).toBe(200);
    const up = JSON.parse(created.body as string);
    expect(up.object).toBe('send-fileUpload');
    expect(up.fileUploadType).toBe(0);
    expect(up.url).toBe(`/api/sends/${up.sendResponse.id}/file/${up.sendResponse.file.id}`);
    expect(up.sendResponse.type).toBe(1);
    expect(up.sendResponse.file.fileName).toBe('report.pdf');

    const bytes = Buffer.from('pdf bytes 12');
    const mp = multipartBody({ key: 'send-key', data: bytes });
    const uploaded = await env.handler(ev('POST', up.url, mp.body, at, mp.contentType));
    expect(uploaded.statusCode).toBe(200);
    const after = JSON.parse(uploaded.body as string);
    expect(after.file.size).toBe(12);
    expect(after.file.sizeName).toBe('12 B');
    expect(env.objects.keys()).toEqual([`sends/${up.sendResponse.id}/${up.sendResponse.file.id}`]);
    expect(env.objects.get(`sends/${up.sendResponse.id}/${up.sendResponse.file.id}`)!.equals(bytes)).toBe(true);

    const access = await env.handler(ev('POST', `/api/sends/access/${up.sendResponse.accessId}`, JSON.stringify({})));
    expect(access.statusCode).toBe(200);
    const acc = JSON.parse(access.body as string);
    expect(acc.data.file.fileName).toBe('report.pdf');

    const dl = await env.handler(ev('GET', `/api/sends/${up.sendResponse.accessId}/file/${up.sendResponse.file.id}`, ''));
    expect(dl.statusCode).toBe(302);
    expect((dl.headers as Record<string, string>).Location).toBe(
      `mem://sends/${up.sendResponse.id}/${up.sendResponse.file.id}`,
    );
  });

  it('delete cascades send file objects; deleteAccount cleans sends + objects', async () => {
    const env = makeEnv();
    const at = await seed(env, 'cascade@example.com');
    const created = JSON.parse(
      (await env.handler(ev('POST', '/api/sends/file/v2', JSON.stringify({ key: 'k', fileName: 'f' }), at))).body as string,
    );
    const mp = multipartBody({ key: 'k', data: Buffer.from('payload') });
    await env.handler(ev('POST', created.url, mp.body, at, mp.contentType));
    expect(env.objects.keys()).toHaveLength(1);

    await env.handler(ev('DELETE', `/api/sends/${created.sendResponse.id}`, '', at));
    expect(env.objects.keys()).toHaveLength(0);

    const created2 = JSON.parse(
      (await env.handler(ev('POST', '/api/sends/file/v2', JSON.stringify({ key: 'k', fileName: 'f2' }), at))).body as string,
    );
    const mp2 = multipartBody({ key: 'k', data: Buffer.from('payload2') });
    await env.handler(ev('POST', created2.url, mp2.body, at, mp2.contentType));
    expect(env.objects.keys()).toHaveLength(1);

    await env.handler(ev('POST', '/api/accounts/delete', JSON.stringify({ masterPasswordHash: PASSWORD }), at));
    expect(env.objects.keys()).toHaveLength(0);
  });

  it('sync.sends lists sends', async () => {
    const env = makeEnv();
    const at = await seed(env, 'sync@example.com');
    await env.handler(
      ev('POST', '/api/sends', JSON.stringify({ id: '44444444-4444-4444-8444-444444444444', type: 0, name: 'in sync', text: { text: 't', hidden: false } }), at),
    );
    const bundle = JSON.parse((await env.handler(ev('GET', '/api/sync', '', at))).body as string);
    expect(bundle.sends).toHaveLength(1);
    expect(bundle.sends[0].name).toBe('in sync');
    expect(bundle.sends[0].object).toBe('send');
  });

  it('anonymous access needs no bearer token; unknown accessId → 404', async () => {
    const env = makeEnv();
    expect((await env.handler(ev('POST', '/api/sends/access/0000000000', JSON.stringify({})))).statusCode).toBe(404);
    expect((await env.handler(ev('GET', '/api/sends/0000000000/file/00000000-0000-4000-8000-000000000000', ''))).statusCode).toBe(404);
  });
});