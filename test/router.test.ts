import { match, Route } from '../src/router';

const ctx = {} as any;

const routes: Route[] = [
  { method: 'GET', pattern: '/api/config', handler: () => 'config' },
  { method: 'GET', pattern: '/api/ciphers/:id', handler: (p) => p },
  { method: 'POST', pattern: '/api/ciphers/:id/attachment', handler: (p) => p },
  { method: 'GET', pattern: '/api/collections/:cid/ciphers/:id', handler: (p) => p },
];

describe('match', () => {
  it('matches an exact path', () => {
    const m = match('GET', '/api/config', routes);
    expect(m).not.toBeNull();
    expect(m!.handler({}, ctx)).toBe('config');
    expect(m!.params).toEqual({});
  });

  it('is method-sensitive', () => {
    expect(match('POST', '/api/config', routes)).toBeNull();
  });

  it('exact match wins over a param pattern', () => {
    const mixed: Route[] = [
      { method: 'GET', pattern: '/api/ciphers/:id', handler: () => 'param' },
      { method: 'GET', pattern: '/api/ciphers/special', handler: () => 'exact' },
    ];
    expect(match('GET', '/api/ciphers/special', mixed)!.handler({}, ctx)).toBe('exact');
  });

  it('extracts and URL-decodes params', () => {
    const m = match('GET', '/api/ciphers/a%2Fb', routes);
    expect(m!.params).toEqual({ id: 'a/b' });
  });

  it('matches multi-param patterns', () => {
    const m = match('GET', '/api/collections/c1/ciphers/c2', routes);
    expect(m!.params).toEqual({ cid: 'c1', id: 'c2' });
  });

  it('does not match a different segment count', () => {
    expect(match('GET', '/api/ciphers/one/two', routes)).toBeNull();
  });

  it('returns null for unknown routes', () => {
    expect(match('GET', '/nope', routes)).toBeNull();
    expect(match('DELETE', '/api/config', routes)).toBeNull();
  });
});