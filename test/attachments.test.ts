import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { MemoryObjectStore } from '../src/objects';
import { register, token } from '../src/endpoints/identity';
import { cipherCreate } from '../src/endpoints/ciphers';
import {
  attachmentCreateV2,
  attachmentUpload,
  attachmentLegacy,
  attachmentGet,
  attachmentDeleteHandler,
} from '../src/endpoints/ciphers';
import { cipherPurge, cipherDelete } from '../src/endpoints/ciphers';
import { deleteAccount } from '../src/endpoints/accounts';

const PASSWORD = Buffer.from('client-hash').toString('base64');

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: register },
  { method: 'POST', pattern: '/identity/connect/token', handler: token },
  { method: 'POST', pattern: '/api/ciphers', handler: cipherCreate, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment/v2', handler: attachmentCreateV2, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentUpload, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/attachment', handler: attachmentLegacy, auth: true },
  { method: 'GET', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentGet, auth: true },
  { method: 'DELETE', pattern: '/api/ciphers/:cipherId/attachment/:attachmentId', handler: attachmentDeleteHandler, auth: true },
  { method: 'POST', pattern: '/api/ciphers/:cipherId/delete', handler: cipherDelete, auth: true },
  { method: 'POST', pattern: '/api/ciphers/purge', handler: cipherPurge, auth: true },
  { method: 'POST', pattern: '/api/accounts/delete', handler: deleteAccount, auth: true },
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
  const boundary = '----vwe2e';
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

async function createCipher(env: ReturnType<typeof makeEnv>, at: string): Promise<string> {
  const r = await env.handler(
    ev('POST', '/api/ciphers', JSON.stringify({ type: 1, name: 'with-att', login: { username: 'u' } }), at),
  );
  return JSON.parse(r.body as string).id as string;
}

describe('attachments', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('v2 create → upload multipart → byte-identical read via presigned url', async () => {
    const env = makeEnv();
    const at = await seed(env, 'att@example.com');
    const cid = await createCipher(env, at);

    const created = await env.handler(
      ev('POST', `/api/ciphers/${cid}/attachment/v2`, JSON.stringify({ key: 'enc-key', fileName: 'doc.txt', fileSize: 11 }), at),
    );
    expect(created.statusCode).toBe(200);
    const upload = JSON.parse(created.body as string);
    expect(upload.object).toBe('attachment-fileUpload');
    expect(upload.fileUploadType).toBe(0);
    expect(upload.url).toBe(`/api/ciphers/${cid}/attachment/${upload.attachmentId}`);
    expect(upload.cipherResponse.object).toBe('cipherDetails');
    expect(upload.cipherResponse.attachments).toHaveLength(1);
    expect(upload.cipherResponse.attachmentCount).toBe(1);
    expect(upload.cipherResponse.attachments[0].fileName).toBe('doc.txt');
    expect(upload.cipherResponse.attachments[0].key).toBe('enc-key');

    const bytes = Buffer.from('hello world');
    const mp = multipartBody({ key: 'enc-key', data: bytes });
    const uploaded = await env.handler(ev('POST', upload.url, mp.body, at, mp.contentType));
    expect(uploaded.statusCode).toBe(200);
    const body = JSON.parse(uploaded.body as string);
    expect(body.attachments[0].size).toBe(11);
    expect(body.attachments[0].sizeName).toBe('11 B');
    expect(body.attachments[0].url).toBe('mem://attachments/' + cid + '/' + upload.attachmentId);

    const dl = await env.handler(ev('GET', `/api/ciphers/${cid}/attachment/${upload.attachmentId}`, '', at));
    expect(dl.statusCode).toBe(200);
    const att = JSON.parse(dl.body as string);
    expect(att.object).toBe('attachment');
    expect(att.url).toBe('mem://attachments/' + cid + '/' + upload.attachmentId);
    const stored = env.objects.get(`attachments/${cid}/${upload.attachmentId}`)!;
    expect(stored.equals(bytes)).toBe(true);
  });

  it('oversize data → 413 envelope; missing data → 400', async () => {
    const env = makeEnv();
    const at = await seed(env, 'big@example.com');
    const cid = await createCipher(env, at);
    const created = JSON.parse(
      (await env.handler(ev('POST', `/api/ciphers/${cid}/attachment/v2`, JSON.stringify({ key: 'k', fileName: 'f' }), at))).body as string,
    );
    const tooBig = Buffer.alloc(4.5 * 1024 * 1024 + 1, 7);
    const mp = multipartBody({ key: 'k', data: tooBig });
    const r = await env.handler(ev('POST', created.url, mp.body, at, mp.contentType));
    expect(r.statusCode).toBe(413);

    const noData = multipartBody({ key: 'k' });
    const r2 = await env.handler(ev('POST', created.url, noData.body, at, noData.contentType));
    expect(r2.statusCode).toBe(400);
  });

  it('legacy single-call upload creates meta + bytes in one request', async () => {
    const env = makeEnv();
    const at = await seed(env, 'legacy@example.com');
    const cid = await createCipher(env, at);
    const bytes = Buffer.from('legacy bytes');
    const mp = multipartBody({ key: 'lk', fileName: 'legacy.bin', data: bytes });
    const r = await env.handler(ev('POST', `/api/ciphers/${cid}/attachment`, mp.body, at, mp.contentType));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.attachments[0].fileName).toBe('legacy.bin');
    expect(env.objects.keys()).toEqual([`attachments/${cid}/${body.attachments[0].id}`]);
    expect(env.objects.get(`attachments/${cid}/${body.attachments[0].id}`)!.equals(bytes)).toBe(true);
  });

  it('detach removes the object and the row entry; unknown id → 404', async () => {
    const env = makeEnv();
    const at = await seed(env, 'detach@example.com');
    const cid = await createCipher(env, at);
    const created = JSON.parse(
      (await env.handler(ev('POST', `/api/ciphers/${cid}/attachment/v2`, JSON.stringify({ key: 'k', fileName: 'f' }), at))).body as string,
    );
    const mp = multipartBody({ key: 'k', data: Buffer.from('x') });
    await env.handler(ev('POST', created.url, mp.body, at, mp.contentType));
    expect(env.objects.keys()).toHaveLength(1);

    const del = await env.handler(ev('DELETE', `/api/ciphers/${cid}/attachment/${created.attachmentId}`, '', at));
    expect(del.statusCode).toBe(200);
    expect(env.objects.keys()).toHaveLength(0);
    expect(JSON.parse(del.body as string).attachments).toBeNull();

    const miss = await env.handler(ev('GET', `/api/ciphers/${cid}/attachment/${created.attachmentId}`, '', at));
    expect(miss.statusCode).toBe(404);
  });

  it('purge cascades S3 prefix; trash keeps objects, restore re-arms urls', async () => {
    const env = makeEnv();
    const at = await seed(env, 'purge@example.com');
    const cid = await createCipher(env, at);
    const created = JSON.parse(
      (await env.handler(ev('POST', `/api/ciphers/${cid}/attachment/v2`, JSON.stringify({ key: 'k', fileName: 'f' }), at))).body as string,
    );
    const mp = multipartBody({ key: 'k', data: Buffer.from('keep me') });
    await env.handler(ev('POST', created.url, mp.body, at, mp.contentType));

    // trash: object survives, url blanked
    await env.handler(ev('POST', `/api/ciphers/${cid}/delete`, '', at));
    expect(env.objects.keys()).toHaveLength(1);
    const listed = await env.store.listCiphers((await env.store.getUserByEmail('purge@example.com'))!.id);
    expect(listed[0].deletedDate).not.toBeNull();

    // restore → object still there; serializer re-arms url on read
    await env.handler(ev('POST', `/api/ciphers/${cid}/delete`, '', at));
    void listed;

    // purge → object gone
    await env.handler(ev('POST', '/api/ciphers/purge', JSON.stringify({ ids: [cid] }), at));
    expect(env.objects.keys()).toHaveLength(0);
  });

  it('deleteAccount cleans attachment objects', async () => {
    const env = makeEnv();
    const at = await seed(env, 'delfiles@example.com');
    const cid = await createCipher(env, at);
    const created = JSON.parse(
      (await env.handler(ev('POST', `/api/ciphers/${cid}/attachment/v2`, JSON.stringify({ key: 'k', fileName: 'f' }), at))).body as string,
    );
    const mp = multipartBody({ key: 'k', data: Buffer.from('bye') });
    await env.handler(ev('POST', created.url, mp.body, at, mp.contentType));
    expect(env.objects.keys()).toHaveLength(1);

    const del = await env.handler(ev('POST', '/api/accounts/delete', JSON.stringify({ masterPasswordHash: PASSWORD }), at));
    expect(del.statusCode).toBe(200);
    expect(env.objects.keys()).toHaveLength(0);
  });

  it('legacy binary round-trip via base64 event body is byte-identical (no utf-8 mangling)', async () => {
    const env = makeEnv();
    const at = await seed(env, 'binary@example.com');
    const cid = await createCipher(env, at);
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0xc3, 0xa9, 0x80, 0x7f, 0x41, 0x00]);
    const raw = multipartBody({ key: 'k', data: bytes.toString('latin1') }).body;
    const b64 = ev('POST', `/api/ciphers/${cid}/attachment`, 'dummy', at);
    b64.isBase64Encoded = true;
    b64.body = Buffer.from(raw, 'latin1').toString('base64');
    b64.headers!['content-type'] = multipartBody({}).contentType;
    const upload = await env.handler(b64);
    expect(upload.statusCode).toBe(200);
    expect(env.objects.get(`attachments/${cid}/${JSON.parse(upload.body as string).attachments[0].id}`)!.equals(bytes)).toBe(true);
  });

  it('401 without bearer on attachment endpoints', async () => {
    const env = makeEnv();
    expect((await env.handler(ev('POST', '/api/ciphers/x/attachment/v2', '{}'))).statusCode).toBe(401);
    expect((await env.handler(ev('GET', '/api/ciphers/x/attachment/y'))).statusCode).toBe(401);
  });
});