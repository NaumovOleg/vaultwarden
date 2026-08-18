import type { APIGatewayProxyResult } from 'aws-lambda';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export function alive(): APIGatewayProxyResult {
  return { statusCode: 200, body: '' };
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