# Phase 02-identity-auth, Plan 02 — connect/token (password + refresh), 2FA gate shape, rate limit, endsession

Status: complete. Commit: (see git log).

## What landed

- **`src/auth.ts`**: `issueSession` (access 1h / refresh 30d TTL; items carry stamp snapshots + `pairedAccess`/`pairedRefresh` so rotation and endsession kill the whole pair), `verifyAccessToken` (used by Plan 03 Bearer middleware), `verifyClientHash` (constant-time, stored salt+iterations), `rateLimit`/`recordFailedLogin`/`clearFailedLogins` (per-IP fixed window, 10/min, 60s TTL).
- **`POST /identity/connect/token`** — form or JSON, case-insensitive fields:
  - password grant: scope check, `auth_request` → invalid_grant for now (Phase 5), GSI1 lookup, wrong password/unknown email → byte-exact `{"error":"invalid_grant","error_description":"Username or password is incorrect."}` (400, never 401), disabled user message, `password` wins over `masterPasswordHash`/`MasterPasswordHash` (Android 2025.12+), rate limit first, device upsert (`USER#{id}|DEV#{deviceId}`), full `authenticated_response` shape with `TwoFactorProviders: null`.
  - 2FA gate: `twoFactorEnabled` (Phase 6 field) → HTTP 200 envelope (`error/error_description/TwoFactorProviders/TwoFactorProviders2/MasterPasswordPolicy` + `TwoFactorToken`); second call via form fields or legacy headers (`Auth-2FA` + `X-Requested-With` + `Auth-2FA-Remember`) validates + consumes the `TFA#` item (5-min TTL).
  - refresh grant: token lookup → type check → stamp check (mismatch deletes session → 400 minimal `{"error":"invalid_grant"}`) → pair rotation (old access+refresh both deleted) → new pair, device `lastUsed` updated.
- **`POST /identity/connect/endsession`** — deletes the pair by refresh or access token; always 200 `{}`.
- Table now has `TimeToLiveAttribute: expiresAt` (sessions/rate/TFA items self-expire).

## Verified

- `npm test`: 63/63 green (7 suites). `tsc --noEmit` clean, `npm run synth` clean (stack diff = TTL only + earlier GSI).
- Byte-exact assertions: success response (every field), wrong-password body, 2FA envelope, rotated/deleted refresh → minimal invalid_grant, unknown-email ≡ wrong-password (no enumeration), rate-limit block + clear-on-success.
- Rotation/revocation proven: refresh rotates pair and old refresh dies; endsession kills pair; securityStamp change revokes.

## Decisions taken during execution

- Stamp-check on refresh deletes the session before returning invalid_grant (plan: "delete session → 400").
- `twoFactorEnabled: boolean` on UserItem gates 2FA (tests force it via `putUser`; no production knob yet — providers arrive in Phase 6).
- 2FA envelope `TwoFactorProviders` is `[]` today; Phase 6 fills provider ints (as strings).
- `auth_request` present → 400 invalid_grant (passwordless is Phase 5).
- Rate limit is per-IP only (`RATE#{ip}|LOGIN`); per-email variant deferred until abuse shows up (ponytail note in store.ts).

## Deferred / next

- Plan 03: devices endpoints (`/devices/identifier`, `/devices/enabled`, `/devices/logout`), Bearer/2FA middleware using `verifyAccessToken`, verification harness (`scripts/e2e-auth.sh`) + deploy handoff to owner.