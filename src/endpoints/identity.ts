import { randomBytes } from 'node:crypto';
import { DEFAULT_KDF, hashPassword, newUuid } from '../crypto';
import { badRequest, BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { UserItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function jsonValue(container: Record<string, unknown>, key: string): unknown {
  const v = container[key];
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

interface KdfConfig {
  type: number;
  iterations: number;
  memory: number | null;
  parallelism: number | null;
}

const FALLBACK_KDF: KdfConfig = {
  type: DEFAULT_KDF.kdfType,
  iterations: DEFAULT_KDF.kdfIterations,
  memory: DEFAULT_KDF.kdfMemory,
  parallelism: DEFAULT_KDF.kdfParallelism,
};

function normalizeKdf(kdf: unknown, fallback: KdfConfig): KdfConfig {
  const k = (kdf ?? {}) as Record<string, unknown>;
  return {
    type: Number(k.kdfType ?? k.type ?? fallback.type),
    iterations: Number(k.kdfIterations ?? k.iterations ?? fallback.iterations),
    memory: k.kdfMemory !== undefined && k.kdfMemory !== null ? Number(k.kdfMemory) : null,
    parallelism:
      k.kdfParallelism !== undefined && k.kdfParallelism !== null ? Number(k.kdfParallelism) : null,
  };
}

// POST /identity/accounts/register and POST /api/accounts/register (both paths).
export async function register(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  if (process.env.SIGNUPS_ALLOWED !== 'true') {
    throw new BitwardenError(403, 'Registration is disabled.');
  }

  const body = ctx.bodyJson;
  const email = String(body.email ?? ctx.bodyForm.get('email') ?? '').trim().toLowerCase();
  if (!email.includes('@')) {
    throw badRequest('Invalid email address.');
  }

  const auth = (jsonValue(body, 'masterPasswordAuthentication') ?? {}) as Record<string, unknown>;
  const clientHash = auth.hash ?? body.masterPasswordHash ?? ctx.bodyForm.get('masterPasswordHash');
  if (typeof clientHash !== 'string' || clientHash === '') {
    throw badRequest('Master password hash is required.');
  }

  if (await ctx.store.getUserByEmail(email)) {
    throw new BitwardenError(400, 'An account with this email already exists.');
  }

  const keys = (jsonValue(body, 'keys') ?? {}) as Record<string, unknown>;
  const salt = randomBytes(64);
  const kdf = normalizeKdf(auth.kdf, FALLBACK_KDF);
  const id = newUuid();
  const user: UserItem = {
    pk: `USER#${id}`,
    sk: 'PROFILE',
    id,
    email,
    passwordHash: hashPassword(Buffer.from(clientHash, 'base64'), salt, 600000).toString('base64'),
    salt: salt.toString('base64'),
    passwordIterations: 600000,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.memory,
    kdfParallelism: kdf.parallelism,
    securityStamp: newUuid(),
    akey: String(body.key ?? ''),
    privateKey: typeof keys.privateKey === 'string' ? keys.privateKey : null,
    publicKey: typeof keys.publicKey === 'string' ? keys.publicKey : null,
    name: String(body.name ?? ''),
    enabled: true,
    premium: true,
    createdAt: new Date().toISOString(),
  };
  await ctx.store.putUser(user);
  return json(200, {});
}

// POST /identity/accounts/prelogin, /identity/accounts/prelogin/password and
// /api/accounts/prelogin. Unknown email returns server defaults, never 404.
export async function prelogin(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const email = String(ctx.bodyJson.email ?? ctx.bodyForm.get('email') ?? '').trim().toLowerCase();
  const user = email.includes('@') ? await ctx.store.getUserByEmail(email) : null;

  const config = user
    ? {
        type: user.kdfType,
        iterations: user.kdfIterations,
        memory: user.kdfMemory,
        parallelism: user.kdfParallelism,
      }
    : FALLBACK_KDF;

  return json(200, {
    kdf: config.type,
    kdfIterations: config.iterations,
    kdfMemory: config.memory,
    kdfParallelism: config.parallelism,
    kdfSettings: {
      kdfType: config.type,
      iterations: config.iterations,
      memory: config.memory,
      parallelism: config.parallelism,
    },
    salt: null,
  });
}