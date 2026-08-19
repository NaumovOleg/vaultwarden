import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler } from '../src/handler';
import type { Route } from '../src/router';
import { MemoryStore } from '../src/store';
import { MemoryObjectStore } from '../src/objects';
import { iconHandler } from '../src/endpoints/icons';

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

const routes: Route[] = [
  { method: 'GET', pattern: '/icons/:host/icon.png', handler: (p, ctx) => iconHandler(p, ctx) },
];

function makeHandler() {
  const store = new MemoryStore();
  const icons = new MemoryObjectStore();
  return {
    store,
    icons,
    handler: createHandler(routes, { store, objects: icons, icons }),
  };
}

function event(rawPath: string): APIGatewayProxyEventV2 {
  return {
    rawPath,
    headers: {},
    requestContext: { http: { method: 'GET' }, requestId: 'tr' },
  } as unknown as APIGatewayProxyEventV2;
}

function mockFetch(status: number, body?: Uint8Array, contentType = 'image/png') {
  (globalThis as any).fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => (body ?? new Uint8Array(0)).buffer,
  }));
}

const realFetch = (globalThis as any).fetch;

afterAll(() => {
  (globalThis as any).fetch = realFetch;
});

describe('icons service', () => {
  it('fetches upstream on miss and serves the bytes', async () => {
    mockFetch(200, new Uint8Array(PNG_BYTES));
    const { handler, icons } = makeHandler();
    const r = await handler(event('/icons/example.com/icon.png'));
    expect(r.statusCode).toBe(200);
    expect(r.isBase64Encoded).toBe(true);
    expect(Buffer.from(r.body as string, 'base64')).toEqual(PNG_BYTES);
    expect(icons.get('icons/example.com.png')).toEqual(PNG_BYTES);
  });

  it('serves from cache without a second upstream call', async () => {
    mockFetch(200, new Uint8Array(PNG_BYTES));
    const { handler } = makeHandler();
    await handler(event('/icons/cached.example.com/icon.png'));
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await handler(event('/icons/cached.example.com/icon.png'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('upstream is duckduckgo ip3, second attempt ip2 on miss', async () => {
    let n = 0;
    (globalThis as any).fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 404, headers: { get: () => 'image/x-icon' }, arrayBuffer: async () => new Uint8Array(0).buffer };
      return { ok: true, status: 200, headers: { get: () => 'image/x-icon' }, arrayBuffer: async () => new Uint8Array([0, 0, 1, 0, 1, 2, 3]).buffer };
    });
    const { handler } = makeHandler();
    const r = await handler(event('/icons/duck.example.com/icon.png'));
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://icons.duckduckgo.com/ip3/duck.example.com.ico');
    expect(urls[1]).toBe('https://icons.duckduckgo.com/ip2/duck.example.com.ico');
    expect(r.statusCode).toBe(200);
    expect((r.headers as Record<string, string>)['Content-Type']).toBe('image/x-icon');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('upstream failure → 404 + negative marker cached, no refetch', async () => {
    mockFetch(500);
    const { handler, icons } = makeHandler();
    const r = await handler(event('/icons/down.example.com/icon.png'));
    expect(r.statusCode).toBe(404);
    expect(icons.get('icons/down.example.com.png')).toEqual(Buffer.alloc(0));
    const fetchMock = (globalThis as any).fetch as jest.Mock;
    await handler(event('/icons/down.example.com/icon.png'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes scheme and strips path', async () => {
    mockFetch(200, new Uint8Array(PNG_BYTES));
    const { handler, icons } = makeHandler();
    await handler(event('/icons/https%3A%2F%2Fwww.Example.com%2Fsub/icon.png'));
    expect(icons.get('icons/www.example.com.png')).toEqual(PNG_BYTES);
  });

  it('rejects junk hosts with 404 without fetching', async () => {
    mockFetch(200, new Uint8Array(PNG_BYTES));
    const { handler } = makeHandler();
    const r = await handler(event('/icons/%2F%2Fetc%2Fpasswd/icon.png'));
    expect(r.statusCode).toBe(404);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });
});