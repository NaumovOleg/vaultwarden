import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createHandler, handler } from '../src/handler';
import { BUILD_TAG } from '../src/endpoints/misc';
import { BitwardenError } from '../src/errors';

function event(method: string, rawPath: string): APIGatewayProxyEventV2 {
  return {
    rawPath,
    requestContext: {
      http: { method },
      requestId: 'test-request-id',
    },
  } as unknown as APIGatewayProxyEventV2;
}

describe('handler', () => {
  it('responds 200 with the build tag to GET /alive', async () => {
    const r = await handler(event('GET', '/alive'));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(BUILD_TAG);
  });

  it('responds 200 to GET /now and GET /api/version', async () => {
    expect((await handler(event('GET', '/now'))).statusCode).toBe(200);
    expect((await handler(event('GET', '/api/version'))).statusCode).toBe(200);
  });

  it('responds 200 JSON with featureFlags to GET /api/config', async () => {
    const r = await handler(event('GET', '/api/config'));
    expect(r.statusCode).toBe(200);
    expect((r.headers as any)['Content-Type']).toContain('application/json');
    expect(JSON.parse(r.body as string).environment.featureFlags).toBeDefined();
  });

  it('unknown path returns the Bitwarden 404 envelope', async () => {
    const r = await handler(event('GET', '/nope'));
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body as string)).toEqual({
      Message: 'Not found.',
      ModelState: {},
      ValidationErrors: [],
    });
  });

  it('unknown route on a known path shape is a 404 envelope, not a 500', async () => {
    const r = await handler(event('POST', '/api/settings'));
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body as string).Message).toBe('Not found.');
  });

  it('a throwing handler maps to the 500 envelope', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = createHandler([
      { method: 'GET', pattern: '/boom', handler: () => { throw new Error('kaboom'); } },
    ]);
    const r = await throwing(event('GET', '/boom'));
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body as string)).toEqual({
      Message: 'Internal server error.',
      ModelState: {},
      ValidationErrors: [],
    });
    errorSpy.mockRestore();
  });

  it('a BitwardenError from a handler maps to its own status', async () => {
    const custom = createHandler([
      {
        method: 'GET',
        pattern: '/forbidden',
        handler: () => { throw new BitwardenError(403, 'Forbidden.'); },
      },
    ]);
    const r = await custom(event('GET', '/forbidden'));
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body as string).Message).toBe('Forbidden.');
  });
});