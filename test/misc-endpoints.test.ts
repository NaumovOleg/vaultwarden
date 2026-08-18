import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { register, token } from '../src/endpoints/identity';
import { domainsGet, domainsPut, hibpBreach } from '../src/endpoints/misc';

const routes: Route[] = [
  { method: 'POST', pattern: '/identity/accounts/register', handler: (p, ctx) => register(p, ctx) },
  { method: 'POST', pattern: '/identity/connect/token', handler: (p, ctx) => token(p, ctx) },
  { method: 'GET', pattern: '/api/settings/domains', handler: (p, ctx) => domainsGet(p, ctx), auth: true },
  { method: 'PUT', pattern: '/api/settings/domains', handler: (p, ctx) => domainsPut(p, ctx), auth: true },
  { method: 'POST', pattern: '/api/settings/domains', handler: (p, ctx) => domainsPut(p, ctx), auth: true },
  { method: 'GET', pattern: '/api/hibp/breach', handler: (p, ctx) => hibpBreach(), auth: true },
];

const PASSWORD = Buffer.from('the-client-side-hash').toString('base64');

function makeHandler() {
  const store = new MemoryStore();
  return { store, handler: createHandler(routes, { store }) };
}

function jsonEvent(method: string, rawPath: string, body: unknown, token?: string): APIGatewayProxyEventV2 {
  return {
    rawPath,
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    requestContext: { http: { method }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

describe('settings/domains + hibp', () => {
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });

  async function registerAndLogin(handler: (e: APIGatewayProxyEventV2) => Promise<any>) {
    await handler(
      jsonEvent('POST', '/identity/accounts/register', {
        email: 'domains@example.com',
        masterPasswordAuthentication: { hash: PASSWORD },
        key: 'k',
        keys: { publicKey: 'p', privateKey: 'q' },
      }),
    );
    const r = await handler(
      jsonEvent('POST', '/identity/connect/token', {
        grant_type: 'password',
        username: 'domains@example.com',
        password: PASSWORD,
        scope: 'api offline_access',
        client_id: 'web',
        deviceType: '9',
        deviceIdentifier: 'dev-dom',
        deviceName: 'D',
      }),
    );
    return (JSON.parse(r.body as string) as { access_token: string }).access_token;
  }

  it('GET returns the global list, empty override by default', async () => {
    const { handler } = makeHandler();
    const tok = await registerAndLogin(handler);
    const r = await handler(jsonEvent('GET', '/api/settings/domains', {}, tok));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.object).toBe('domains');
    expect(body.globalEquivalentDomains.length).toBeGreaterThan(0);
    expect(body.equivalentDomains).toEqual([]);
    expect(body.excludedGlobalEquivalentDomains).toEqual([]);
  });

  it('PUT persists user override and GET + re-check reflect it', async () => {
    const { store, handler } = makeHandler();
    const tok = await registerAndLogin(handler);
    const put = await handler(
      jsonEvent('PUT', '/api/settings/domains', {
        equivalentDomains: [['example.com', 'example.org']],
        excludedGlobalEquivalentDomains: [1],
      }, tok),
    );
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.body as string).equivalentDomains).toEqual([['example.com', 'example.org']]);

    const get = await handler(jsonEvent('GET', '/api/settings/domains', {}, tok));
    const body = JSON.parse(get.body as string);
    expect(body.equivalentDomains).toEqual([['example.com', 'example.org']]);
    expect(body.excludedGlobalEquivalentDomains).toEqual([1]);
    const user = await store.getUserByEmail('domains@example.com');
    expect(user!.domainsOverride?.equivalentDomains).toEqual([['example.com', 'example.org']]);
  });

  it('malformed override body → 400', async () => {
    const { handler } = makeHandler();
    const tok = await registerAndLogin(handler);
    const r = await handler(jsonEvent('PUT', '/api/settings/domains', { equivalentDomains: 'nope' }, tok));
    expect(r.statusCode).toBe(400);
  });

  it('hibp breach is an honest 404 stub', async () => {
    const { handler } = makeHandler();
    const tok = await registerAndLogin(handler);
    const r = await handler(jsonEvent('GET', '/api/hibp/breach?username=abc', {}, tok));
    expect(r.statusCode).toBe(404);
  });
});