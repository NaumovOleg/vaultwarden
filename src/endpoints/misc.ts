import type { APIGatewayProxyResult } from 'aws-lambda';
import { BitwardenError } from '../errors';
import type { RouteContext } from '../router';
import type { UserItem } from '../store';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// Default groups mirrored from vaultwarden domains.rs (subset; the full list
// only affects the "Equivalent domains" autofill helper, not correctness).
const GLOBAL_EQUIVALENT_DOMAINS: string[][] = [
  ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.co.jp'],
  ['github.com', 'githubusercontent.com'],
  ['google.com', 'googleusercontent.com', 'googleapis.com'],
  ['paypal.com', 'paypalobjects.com'],
];

// GET /api/settings/domains — equivalent domains with the user override.
export async function domainsGet(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const override = user.domainsOverride;
  return json(200, {
    equivalentDomains: override?.equivalentDomains ?? [],
    globalEquivalentDomains: GLOBAL_EQUIVALENT_DOMAINS,
    excludedGlobalEquivalentDomains: override?.excludedGlobalEquivalentDomains ?? [],
    object: 'domains',
  });
}

// PUT|POST /api/settings/domains — persist the user's domain override.
export async function domainsPut(params: Record<string, string>, ctx: RouteContext): Promise<unknown> {
  const user = ctx.user!;
  const body = ctx.bodyJson as Record<string, unknown>;
  const equivalentDomains = body.equivalentDomains;
  const excluded = body.excludedGlobalEquivalentDomains;
  if (!Array.isArray(equivalentDomains) || !Array.isArray(excluded)) {
    throw new BitwardenError(400, 'Invalid request.');
  }
  const updated: UserItem = {
    ...user,
    domainsOverride: {
      equivalentDomains: equivalentDomains.filter(
        (g): g is string[] => Array.isArray(g) && g.every((d) => typeof d === 'string'),
      ),
      excludedGlobalEquivalentDomains: excluded.filter((n): n is number => typeof n === 'number'),
    },
    revisionDate: new Date().toISOString(),
    revisionDateMs: Date.now(),
  };
  await ctx.store.putUser(updated);
  return domainsGet({}, { ...ctx, user: updated });
}

// GET /api/hibp/breach — stub 404: honest "check unavailable" (vaultwarden
// also errors when HIBP is unconfigured; web vault degrades gracefully).
export function hibpBreach(): APIGatewayProxyResult {
  return { statusCode: 404, headers: JSON_HEADERS, body: '' };
}

export const BUILD_TAG = '2026-08-18-auth-fix';

export function alive(): APIGatewayProxyResult {
  return { statusCode: 200, body: BUILD_TAG };
}

export function now(): APIGatewayProxyResult {
  return { statusCode: 200, body: new Date().toISOString() };
}

export function version(): APIGatewayProxyResult {
  return { statusCode: 200, body: process.env.VERSION ?? '1.0.0-dev' };
}

// Mirrors vaultwarden's /api/config (src/api/core/mod.rs#config).
export function config(): APIGatewayProxyResult {
  const host = process.env.DEFAULT_DOMAIN ?? 'localhost';
  const domain = host.startsWith('http') ? host : `https://${host}`;
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      version: process.env.VERSION ?? '1.0.0-dev',
      gitHash: null,
      server: { name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden' },
      settings: {
        disableUserRegistration: process.env.SIGNUPS_ALLOWED !== 'true',
        suppressOnboardingInterstitials: false,
      },
      environment: {
        vault: domain,
        api: `${domain}/api`,
        identity: `${domain}/identity`,
        notifications: `${domain}/notifications`,
        sso: '',
        cloudRegion: null,
        // legacy fields older clients expect
        versioning: { serverVersion: process.env.VERSION ?? '1.0.0-dev' },
        featureFlags: {},
      },
      push: { pushTechnology: 0, vapidPublicKey: null },
      featureStates: { 'pm-19148-innovation-archive': true },
      communication: null,
      object: 'config',
    }),
  };
}