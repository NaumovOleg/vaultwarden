// Jest environment: signJwt requires JWT_SECRET (no hardcoded fallback in
// src/crypto.ts). Tests exercise flows that issue sessions, so set a test
// key here; the security tests assert the production behavior.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'jest-test-secret';