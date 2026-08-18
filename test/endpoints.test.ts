import { alive, config, now, version } from '../src/endpoints/misc';
import { BitwardenError, internalError, notFound, toErrorBody } from '../src/errors';

describe('misc endpoints', () => {
  it('alive returns 200 with empty body', () => {
    const r = alive();
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('');
  });

  it('now returns an ISO-8601 UTC timestamp', () => {
    const r = now();
    expect(r.statusCode).toBe(200);
    expect(new Date(r.body as string).toISOString()).toBe(r.body);
    expect(r.body).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it('version returns the configured version as plain text', () => {
    const old = process.env.VERSION;
    process.env.VERSION = '3.2.1';
    const r = version();
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('3.2.1');
    process.env.VERSION = old;
  });

  it('config returns the Bitwarden shape with featureFlags and versioning', () => {
    const old = { v: process.env.VERSION, d: process.env.DEFAULT_DOMAIN, s: process.env.SIGNUPS_ALLOWED };
    process.env.VERSION = '1.0.0-test';
    process.env.DEFAULT_DOMAIN = 'vault.example.com';
    process.env.SIGNUPS_ALLOWED = 'true';

    const r = config();
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body as string);
    expect(body.object).toBe('config');
    expect(typeof body.environment.featureFlags).toBe('object');
    expect(body.environment.versioning.serverVersion).toBe('1.0.0-test');
    expect(body.environment.api).toBe('https://vault.example.com/api');
    expect(body.environment.vault).toBe('https://vault.example.com');
    expect(body.settings.disableUserRegistration).toBe(false);
    expect(typeof body.featureStates).toBe('object');

    process.env.VERSION = old.v;
    process.env.DEFAULT_DOMAIN = old.d;
    process.env.SIGNUPS_ALLOWED = old.s;
  });
});

describe('errors', () => {
  it('notFound produces the exact Bitwarden 404 envelope', () => {
    const err = notFound();
    expect(err.status).toBe(404);
    expect(JSON.parse(toErrorBody(err))).toEqual({
      Message: 'Not found.',
      ModelState: {},
      ValidationErrors: [],
    });
  });

  it('internalError produces the 500 envelope', () => {
    const err = internalError();
    expect(err.status).toBe(500);
    expect(JSON.parse(toErrorBody(err))).toEqual({
      Message: 'Internal server error.',
      ModelState: {},
      ValidationErrors: [],
    });
  });

  it('populates ModelState and ValidationErrors when set', () => {
    const err = new BitwardenError(400, 'Bad stuff', { field: ['is wrong'] }, [{ code: 1 }]);
    const parsed = JSON.parse(toErrorBody(err));
    expect(parsed.ModelState).toEqual({ field: ['is wrong'] });
    expect(parsed.ValidationErrors).toEqual([{ code: 1 }]);
  });
});