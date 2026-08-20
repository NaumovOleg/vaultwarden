import { EMAIL_RE, verifyClientHash } from '../auth';
import { recoveryCode, recoveryHash, totpCode, totpSecret, totpVerify } from '../crypto';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { UserItem } from '../store';
import { jsonValue } from './identity';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function requirePassword(body: Record<string, unknown>, user: UserItem): void {
  if (!verifyClientHash(user, jsonValue(body, 'masterPasswordHash'))) {
    throw new BitwardenError(400, 'Invalid password.');
  }
}

function twoFactorEnabled(user: UserItem): boolean {
  return !!(user.totpSecret || user.email2faEnabled);
}

async function clearRecoveryCodes(user: UserItem, ctx: RouteContext): Promise<void> {
  for (const hash of await ctx.store.listRecoveryHashes(user.id)) {
    await ctx.store.deleteRecoveryHash(user.id, hash);
  }
}

// GET /api/two-factor — provider rows for the web vault settings page.
export async function twoFactorList(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const data: Record<string, unknown>[] = [
    {
      Object: 'twoFactorAuthenticator',
      Enabled: !!user.totpSecret,
    },
    {
      Object: 'twoFactorEmail',
      Enabled: user.email2faEnabled,
      Email: user.email2faEnabled && user.email2faAddress ? user.email2faAddress : '',
    },
  ];
  return json(200, { Data: data, Object: 'twoFactor' });
}

// POST /api/two-factor/get-authenticator — key (QR) for the setup screen.
// When disabled, a fresh pending key is generated; enable must use it.
export async function getAuthenticator(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  let key = user.totpSecret ?? user.totpPendingSecret;
  if (!key) {
    key = totpSecret();
    const updated: UserItem = { ...user, totpPendingSecret: key };
    await ctx.store.putUser(updated);
  }
  return json(200, { enabled: !!user.totpSecret, key, object: 'twoFactorAuthenticator' });
}

// POST|PUT /api/two-factor/authenticator — enable TOTP with the shown key.
export async function authenticatorEnable(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  requirePassword(body, user);
  const key = typeof body.key === 'string' ? body.key : '';
  const token = typeof body.token === 'string' ? body.token : String(body.token ?? '');
  if (typeof key !== 'string' || typeof token !== 'string' || !key || !token) {
    throw new BitwardenError(400, 'Invalid request.');
  }
  if (key !== user.totpSecret && key !== user.totpPendingSecret) {
    throw new BitwardenError(400, 'Invalid two-factor key.');
  }
  if (!totpVerify(key, token)) {
    throw new BitwardenError(400, 'Invalid two-factor token.');
  }
  let recovery = await ctx.store.listRecoveryHashes(user.id);
  if (recovery.length === 0) {
    const codes = Array.from({ length: 5 }, recoveryCode);
    recovery = codes.map(recoveryHash);
    for (const hash of recovery) await ctx.store.putRecoveryHash(user.id, hash);
  }
  const updated: UserItem = {
    ...user,
    totpSecret: key,
    totpPendingSecret: null,
    twoFactorEnabled: true,
  };
  await ctx.store.putUser(updated);
  await ctx.store.putAudit(user.id, 'TFA_ENABLED', { provider: 'authenticator' });
  return json(200, {});
}

// DELETE /api/two-factor/authenticator — disable TOTP.
export async function authenticatorDisable(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  await clearRecoveryCodes(user, ctx);
  const updated: UserItem = {
    ...user,
    totpSecret: null,
    totpPendingSecret: null,
    twoFactorEnabled: twoFactorEnabled(user) && !user.totpSecret,
  };
  await ctx.store.putUser(updated);
  await ctx.store.putAudit(user.id, 'TFA_DISABLED', { provider: 'authenticator' });
  return json(200, {});
}

// POST /api/two-factor/get-recover — recovery codes (hashes, like vaultwarden;
// login accepts the code itself or its hash, so the displayed strings work).
export async function getRecoveryCodes(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  if (!user.totpSecret && !user.email2faEnabled) {
    throw new BitwardenError(400, 'Two-step login is not enabled.');
  }
  const codes = await ctx.store.listRecoveryHashes(user.id);
  return json(200, { codes, object: 'twoFactorRecovery' });
}

// POST /api/two-factor/disable — disable one provider by type.
export async function twoFactorDisable(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  requirePassword(body, user);
  const type = Number(jsonValue(body, 'type'));
  if (type === 0 && user.totpSecret) {
    await clearRecoveryCodes(user, ctx);
    const updated: UserItem = {
      ...user,
      totpSecret: null,
      totpPendingSecret: null,
      twoFactorEnabled: !!user.email2faEnabled,
    };
    await ctx.store.putUser(updated);
    await ctx.store.putAudit(user.id, 'TFA_DISABLED', { provider: 'authenticator' });
    return json(200, {});
  }
  if (type === 1 && user.email2faEnabled) {
    const updated: UserItem = {
      ...user,
      email2faEnabled: false,
      email2faAddress: null,
      twoFactorEnabled: !!user.totpSecret,
    };
    await ctx.store.putUser(updated);
    await ctx.store.putAudit(user.id, 'TFA_DISABLED', { provider: 'email' });
    return json(200, {});
  }
  throw new BitwardenError(400, 'Two-step login provider not found.');
}

const EMAIL_CODE_TTL_SECONDS = 300;

// Mask an address like vaultwarden: first char + *** + @domain.
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}

function makeEmailCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/two-factor/get-email — setup shape for the web vault row.
export async function getEmailSetup(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  requirePassword(ctx.bodyJson as Record<string, unknown>, user);
  return json(200, {
    enabled: user.email2faEnabled,
    email: user.email2faEnabled && user.email2faAddress ? user.email2faAddress : '',
    object: 'twoFactorEmail',
  });
}

// POST /api/two-factor/send-email — setup code to the given address. With
// SES the code goes by mail; without it the code is returned in the body for
// the CLI/e2e flow (ponytail dev fallback). Never logged.
export async function sendEmailSetup(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email : '';
  if (!EMAIL_RE.test(email)) {
    throw new BitwardenError(400, 'Invalid email.');
  }
  const code = makeEmailCode();
  await ctx.store.putEmail2faCode(user.id, code, Math.floor(Date.now() / 1000) + EMAIL_CODE_TTL_SECONDS);
  if (process.env.SES_SOURCE !== undefined && process.env.SES_SOURCE !== '') {
    try {
      await ctx.mailer.send(email, 'Your verification code', `Your vaultwarden email 2FA code is ${code}.`);
      return json(200, { email: maskEmail(email) });
    } catch (err) {
      // SES rejected (unverified recipient, quota). Fall through: the code
      // goes in the response so the flow survives (no mailer, no email).
      console.error(`[2fa] SES send failed for ${maskEmail(email)}`, err);
    }
  }
  return json(200, { email: maskEmail(email), code });
}

// POST /api/two-factor/send-email-login — login re-send; comes with a
// twoFactorToken or from a challenged session. Lazy: reuse the same store slot.
export async function sendEmailLogin(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const body = ctx.bodyJson as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email : '';
  const user = ctx.user ?? (email ? await ctx.store.getUserByEmail(email.toLowerCase()) : null);
  if (!user || !user.email2faEnabled) {
    throw new BitwardenError(404, 'Not found.');
  }
  const code = makeEmailCode();
  await ctx.store.putEmail2faCode(user.id, code, Math.floor(Date.now() / 1000) + EMAIL_CODE_TTL_SECONDS);
  if (process.env.SES_SOURCE !== undefined && process.env.SES_SOURCE !== '') {
    // email2faAddress stores a masked display address only; the login form
    // resends the full address in the body.
    if (EMAIL_RE.test(email)) {
      try {
        await ctx.mailer.send(email, 'Your verification code', `Your vaultwarden email 2FA code is ${code}.`);
        return json(200, {});
      } catch (err) {
        console.error(`[2fa] SES send failed for ${maskEmail(email)}`, err);
      }
    } else {
      throw new BitwardenError(400, 'Invalid email.');
    }
  }
  return json(200, {});
}

// POST|PUT /api/two-factor/email — enable email 2FA after the setup code.
export async function emailEnable(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  requirePassword(body, user);
  const email = typeof body.email === 'string' ? body.email : '';
  const token = typeof body.token === 'string' ? body.token : String(body.token ?? '');
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(token)) {
    throw new BitwardenError(400, 'Invalid request.');
  }
  const stored = await ctx.store.getEmail2faCode(user.id);
  if (!stored || stored !== token) {
    throw new BitwardenError(400, 'Invalid two-factor token.');
  }
  await ctx.store.deleteEmail2faCode(user.id);
  const updated: UserItem = {
    ...user,
    email2faEnabled: true,
    email2faAddress: maskEmail(email),
    twoFactorEnabled: true,
  };
  await ctx.store.putUser(updated);
  await ctx.store.putAudit(user.id, 'TFA_ENABLED', { provider: 'email' });
  return json(200, {});
}

// Login-side helpers shared with identity.ts.

// 2FA challenge for /identity/connect/token when a code is required.
export function twoFactorChallenge(user: UserItem, token: string): Record<string, unknown> {
  const providers: number[] = [];
  const providers2: Record<string, unknown> = {};
  if (user.totpSecret) {
    providers.push(0);
    providers2['0'] = { Object: 'twoFactorAuthenticator', Enabled: true };
  }
  if (user.email2faEnabled) {
    providers.push(1);
    providers2['1'] = {
      Object: 'twoFactorEmail',
      Enabled: true,
      Email: user.email2faAddress ?? user.email,
    };
  }
  return {
    error: 'invalid_grant',
    error_description: 'Two factor required.',
    TwoFactorProviders: providers,
    TwoFactorProviders2: providers2,
    MasterPasswordPolicy: { Object: 'masterPasswordPolicy' },
    TwoFactorToken: token,
  };
}

// Validate a 2FA code for provider type. 0 = authenticator (incl. recovery
// codes), 1 = email code (plan 02). Unknown/disabled provider → false. An
// emailed recover code (sendRecoveryCode) satisfies any active provider.
export async function verifyTwoFactorCode(user: UserItem, provider: number, code: string, ctx: RouteContext): Promise<boolean> {
  const recover = await ctx.store.getRecoverCode(user.id);
  if (recover && recover.code === code) {
    await ctx.store.deleteRecoverCode(user.id);
    return true;
  }
  if (provider === 0 && user.totpSecret) {
    if (totpVerify(user.totpSecret, code)) return true;
    const hashes = await ctx.store.listRecoveryHashes(user.id);
    const inputHash = recoveryHash(code);
    return hashes.includes(inputHash) || hashes.includes(code);
  }
  if (provider === 1 && user.email2faEnabled) {
    const emailCode = await ctx.store.getEmail2faCode(user.id);
    if (emailCode && emailCode === code) {
      await ctx.store.deleteEmail2faCode(user.id);
      return true;
    }
  }
  return false;
}

// Exported for the authenticator setup test to mint valid codes.
export { totpCode };
