import { startServer } from '../src/dev';

describe('dev server', () => {
  const oldSignups = process.env.SIGNUPS_ALLOWED;
  beforeAll(() => {
    process.env.SIGNUPS_ALLOWED = 'true';
  });
  afterAll(() => {
    process.env.SIGNUPS_ALLOWED = oldSignups;
  });

  it('serves the real handler over HTTP: alive, register, token, sync', async () => {
    const dev = await startServer(0);
    try {
      const alive = await fetch(`${dev.url}/alive`);
      expect(alive.status).toBe(200);

      const password = Buffer.from('client-hash').toString('base64');
      const reg = await fetch(`${dev.url}/identity/accounts/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dev@example.com', masterPasswordAuthentication: { hash: password } }),
      });
      expect(reg.status).toBe(200);

      const login = await fetch(`${dev.url}/identity/connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          username: 'dev@example.com',
          password,
          scope: 'api offline_access',
          deviceIdentifier: 'dev-server',
        }).toString(),
      });
      expect(login.status).toBe(200);
      const token = (await login.json() as { access_token: string }).access_token;

      const sync = await fetch(`${dev.url}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
      expect(sync.status).toBe(200);
    } finally {
      await dev.close();
    }
  });
});