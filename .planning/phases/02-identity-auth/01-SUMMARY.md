# Phase 02-identity-auth, Plan 01 — storage + crypto + register/prelogin

Status: complete. Commits: (see git log).

## What landed

- **GSI1** (`EMAIL#{email}` → PROFILE) on VaultTable; asserted in stack tests.
- **Runtime deps** (first in project): `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` 3.111.0; bundled into the Lambda by esbuild.
- **`src/crypto.ts`**: `newToken` (32B base64url), `newUuid`, `hashPassword`/`verifyPassword` (PBKDF2-SHA256 64B wrap, `timingSafeEqual`), `ctEq`, `DEFAULT_KDF` (type 0, 600k).
- **`src/store.ts`**: `Store` interface + `DynamoStore` (DynamoDBDocumentClient, `VAULT_TABLE` env, GSI1 query) + `MemoryStore` for tests; items: `USER#{id}|PROFILE`, `USER#{id}|DEV#`, `SESS#`/`TFA#`, `RATE#` (device/session/TFA/rate methods committed now, consumed in Plan 02).
- **Body parsing** in `createHandler`: form vs JSON by content-type, base64-aware; `Route.handler(params, ctx)` signature with `ctx = {store, bodyRaw, bodyForm, bodyJson}`.
- **`src/endpoints/identity.ts`**: register on `/identity/accounts/register` + `/api/accounts/register` (signups gate 403, dup email 400, `masterPasswordAuthentication.hash` preferred, server 600k wrap, email lowercased, premium=true); prelogin on all 3 paths (kdfConfig + legacy dual emit, unknown email → defaults, never 404).
- Stack: `VAULT_TABLE` env + `grantReadWriteData`.

## Verified

- `npm test`: 50/50 green (6 suites — added crypto.test.ts, endpoints-auth.test.ts; stack/router tests extended for new signatures + GSI1 + write grant).
- `tsc --noEmit` clean; `npm run synth` clean (template has GSI1).

## Decisions taken during execution

- Store method names for rate limiting are `getRate/putRate/incrementRate/clearRate` (plan named them countFailedLogins/etc.; same semantics, picked before Plan 02 uses them).
- `deleteSessionsForDevice` is a no-op in DynamoStore by design (sessions are direct-key lookups; rotation deletes by token) — marked with a `ponytail:` comment, see store.ts.
- Register missing-field errors use generic 400 messages (plan pinned only the duplicate-email message).

## Deferred / next

- Plan 02: `connect/token` (client_credentials + password grant), access/refresh session pairs + rotation, 2FA-required envelope, login rate limit, `endsession`. Store + crypto already in place for it.
- E2E against a real deployment remains owner-run (deploy with `--context vaultwarden:signupsAllowed=true`, run `scripts/e2e-auth.sh` when it lands, redeploy with `false`).
