import { hashPassword, verifyPassword, ctEq, newToken, newUuid, DEFAULT_KDF } from '../src/crypto';

describe('crypto', () => {
  it('hashPassword produces a 64-byte output by default', () => {
    const salt = Buffer.from('a1b2c3', 'utf-8');
    expect(hashPassword(Buffer.from('secret'), salt, 600_000).length).toBe(64);
  });

  it('verifyPassword: right secret true, wrong secret false', () => {
    const salt = Buffer.from('salt');
    const stored = hashPassword(Buffer.from('correct horse'), salt, 600_000);
    expect(verifyPassword(Buffer.from('correct horse'), salt, stored, 600_000)).toBe(true);
    expect(verifyPassword(Buffer.from('wrong'), salt, stored, 600_000)).toBe(false);
  });

  it('different iterations produce a different hash', () => {
    const salt = Buffer.from('salt');
    const stored = hashPassword(Buffer.from('secret'), salt, 600_000);
    expect(verifyPassword(Buffer.from('secret'), salt, stored, 600_001)).toBe(false);
  });

  it('ctEq is a string equality that also rejects unequal lengths', () => {
    expect(ctEq('abc', 'abc')).toBe(true);
    expect(ctEq('abc', 'abd')).toBe(false);
    expect(ctEq('abc', 'abcd')).toBe(false);
  });

  it('newToken produces unique base64url strings', () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('newUuid produces a v4 uuid', () => {
    expect(newUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('DEFAULT_KDF is PBKDF2-SHA256 with 600k iterations', () => {
    expect(DEFAULT_KDF).toEqual({
      kdfType: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
    });
  });
});