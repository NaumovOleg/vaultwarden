# Phase 02-identity-auth, Plan 03 — Bearer middleware, devices, e2e harness + deploy handoff

Status: code complete; **deploy + human checkpoint = owner-run** (Task 3). Commit: (see git log).

## What landed

- **`src/auth.ts`**: `authenticate()` — parses `Authorization: Bearer <token>` → `verifyAccessToken` (type check, user exists, securityStamp match; **stamp mismatch deletes the session** → revoked). Route dispatch: `auth: true` on a route → unauthenticated requests get the exact 401 `{"Message":"Unauthorized"}`; authenticated ones get `ctx.user` + `ctx.session`.
- **`src/endpoints/devices.ts`** (all Bearer-authed):
  - `GET /api/devices` → `{object:'list', data:[{id,name,type,identifier,creationDate,lastUsedDate,object:'device'}], continuationToken:null}` (per-user scope)
  - `GET /api/devices/identifier/{deviceId}` → device or 404 envelope
  - `PUT|POST /api/devices/identifier/{deviceId}/token` → push token registration → `200 {}`
  - `PUT|POST /api/devices/identifier/{deviceId}/clear-token` → `200 {}`
- `DeviceItem.creationDate` added; login upsert preserves it across re-logins.
- **`scripts/e2e-auth.sh`** (+ `npm run e2e:auth`): 10-step curl matrix — prelogin (both paths) → register → duplicate-400 → wrong-password exact body → full token shape → Bearer devices ≥1 → refresh rotation (old dies) → endsession → revoked access check. Usage error when URL missing; PASS/FAIL output; non-zero exit on failure. Warns when register is disabled (signups gate).

## Verified (off-deploy)

- `npm test`: 72/72 green (8 suites). `tsc --noEmit` clean. `npm run synth` clean (stack unchanged this plan — handler-only diff).
- 401 exact envelope, per-user device scoping, push token register/clear, revocation by endsession and by stamp change — all asserted.

## DEPLOY HANDOFF (owner) — Task 3

Standing policy: owner deploys ("write the whole project, then I deploy").

1. `npm ci && npm run webvault && npm run synth`
2. `npx cdk deploy vaultwarden --context vaultwarden:signupsAllowed=true`
3. `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online` — all 10 steps PASS
4. Redeploy steady state: `npx cdk deploy vaultwarden --context vaultwarden:signupsAllowed=false`
5. Human checkpoint: open https://vaultwarden.free-bert.online → log in with `e2e@example.com` / `e2e-test-password` → **web vault login ACCEPTED** (reaches the empty-vault screen; `/api/sync` may 404 — that's Phase 3).
6. Report breakage here → fix cycle.

## Decisions taken during execution

- 401 body is the exact Bitwarden `{"Message":"Unauthorized"}` (not the fuller envelope).
- endsession deletes the whole pair; test asserts revoked access token → 401.
- e2e step 10 tolerates "access token still valid" with a NOTE (revocation timing), per plan.

## Deferred / next

- Phase 3 (cipher surface): `/api/sync`, Bearer-authed cipher CRUD — `verifyAccessToken`/middleware already reusable.
- Real 2FA providers (TOTP/email) = Phase 6; device push integration = later phase.
