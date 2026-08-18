---
phase: 02-identity-auth
plan: 03
type: execute
wave: 3
depends_on: [01, 02]
files_modified: [src/handler.ts, src/auth.ts, src/endpoints/devices.ts, test/handler.test.ts, test/devices.test.ts, package.json, scripts/e2e-auth.sh]
autonomous: false

must_haves:
  truths:
    - "Bearer-authenticated endpoints resolve the opaque access token → session → user with stamp check"
    - "GET /api/devices + /api/devices/identifier/{id} + token/clear-token exist and work (pitfall 1.12 device flow)"
    - "scripts/e2e-auth.sh runs the full login lifecycle against a deployed URL"
    - "Web Vault login page accepts credentials and reaches the sync screen (deploy + human check)"
  artifacts:
    - "src/auth.ts Bearer middleware + 401 envelope"
    - "src/endpoints/devices.ts"
    - "scripts/e2e-auth.sh (curl matrix)"
    - "03-SUMMARY.md with deploy handoff notes"
  key_links:
    - "handler wraps route dispatch with auth when the route declares it"
    - "device endpoints read the session user from the Bearer token"
---

<objective>
Close the auth loop: bearer authorization middleware, the devices surface, and a deploy+verification harness that proves "register → prelogin → token → refresh → logout" against the live stack — plus the human Web Vault login checkpoint.

Purpose: Phase 2's success criterion is the web vault login screen accepting credentials; that only happens on the deployed stack.
Output: middleware + devices + e2e script; deploy handoff; summary.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.2 devices, §3.3)
@.planning/research/PITFALLS.md (§1.12)
@src/handler.ts
@src/auth.ts
@src/endpoints/identity.ts
@lib/vaultwarden-stack.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Bearer middleware + devices endpoints</name>
  <files>src/auth.ts, src/handler.ts, src/endpoints/devices.ts, test/devices.test.ts, test/handler.test.ts</files>
  <action>
    `src/auth.ts`:
    - `authenticate(store, event)`: parse `Authorization: Bearer <token>` → `verifyAccessToken` → read `USER#{id}|PROFILE` → stamp mismatch → delete session, return null → resolve `{user, session}`; missing/invalid → null.
    - `requireAuth` wrapper used by route definitions: `auth: true` flag on `Route` (router type gains optional `auth?: boolean`); handler dispatch: route.auth && !authenticated → 401 `{"Message":"Unauthorized"}` (Bitwarden 401 envelope? verify against vaultwarden `err!("Unauthorized")` shape at execution time; official server returns `{"Message":"Unauthorized"}`).
    - `src/endpoints/devices.ts` (all authed):
      - `GET /api/devices` → `{"object":"list","data":[{id, name, type, identifier, creationDate, lastUsedDate, "object":"device"}],"continuationToken":null}`
      - `GET /api/devices/identifier/{deviceId}` → device or 404 envelope.
      - `PUT|POST /api/devices/identifier/{deviceId}/token` → body/push token registration → `{}` (200, not 204).
      - `PUT|POST /api/devices/identifier/{deviceId}/clear-token` → `{}`.
    - Store: add `listDevices(userId)`, `putDeviceToken(userId, deviceId, pushToken)`; MemoryStore + DynamoStore impls.
    - Stack: `VAULT_TABLE` env var added (Plan 01 Task 2 of this phase) + widen the table grant to read/write (`grantReadWriteData` replacing the Phase-1 read grant) — do it in THIS plan if not already done in Plan 01.
  </verify>
  `npm test` green; `tsc --noEmit` green. ts-node smoke: password grant → Bearer GET /api/devices → list contains the device created at login; no/bad token → 401 envelope; unknown device id → 404 envelope.
  <done>Auth middleware + devices surface live and tested.</done>
</task>

<task type="auto">
  <name>Task 2: e2e-auth.sh curl harness</name>
  <files>scripts/e2e-auth.sh, package.json</files>
  <action>
    `scripts/e2e-auth.sh` (bash, executable) — takes `URL` (+ optional `EMAIL`/`PASSWORD`, default `e2e@example.com`/`e2e-test-password`), asserts each step with explicit pass/fail output and non-zero exit on first failure:
    1. `POST $URL/identity/accounts/prelogin` → 200, kdfConfig present
    2. `POST $URL/identity/accounts/prelogin/password` → 200, kdfConfig present (pitfall 1.1)
    3. `POST $URL/identity/accounts/register` (masterPasswordHash + key + keys) → 200 {}
    4. duplicate register → 400 (not 500)
    5. `POST $URL/identity/connect/token` grant_type=password with wrong hash → 400 `{"error":"invalid_grant",...}` exact
    6. correct grant → 200, capture access_token + refresh_token; assert `expires_in: 3600`, `token_type: "Bearer"`, Kdf fields present
    7. `GET $URL/api/devices` with Bearer → 200, `"object":"list"`, device count ≥ 1
    8. refresh grant → 200, NEW refresh_token; old refresh → 400 `{"error":"invalid_grant"}` (rotation)
    9. endsession → 200; refresh with rotated token → 400
    10. `GET $URL/api/devices` with the revoked access token → 401 (stamp/revocation honored — actually 401 only if session deleted by endsession: assert 401 OR 200-0-devices as per implementation; pin at execution time)
    Register step needs signups open: the script PRINTS a warning if the register step fails with "Registration is disabled." — expect `vaultwarden:signupsAllowed=true` during the phase-2 verification deploy, `false` afterwards (cdk.json keep `false`; pass context at deploy).
    Add `"e2e:auth": "bash scripts/e2e-auth.sh"` to package.json scripts.
  </verify>
  `bash scripts/e2e-auth.sh https://<deployed-domain>` — all steps pass on the live stack (run by owner at deploy; unit-checked locally by pointing at nothing → fails cleanly with "usage" when URL missing).
  <done>Harness exists, deterministic, and documents its own pass/fail output.</done>
</task>

<task type="checkpoint:human-verify">
  <name>Task 3: deploy + live verification + Web Vault login checkpoint</name>
  <files>lib/vaultwarden-stack.ts</files>
  <action>
    Deployment is OWNER-RUN per the standing decision ("write the whole project, then I deploy"). This task packages the handoff:
    1. `npm ci && npm run webvault && npm run synth` — owner runs.
    2. `npx cdk deploy vaultwarden --context vaultwarden:signupsAllowed=true` (registration open for the e2e account), then `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online` — owner runs.
    3. Redeploy with `--context vaultwarden:signupsAllowed=false` (steady state).
    4. Human checkpoint: open the CloudFront URL in a browser, log in with the e2e account, confirm the web vault renders and the login is ACCEPTED (reaches an empty-vault screen even if /api/sync 404s — sync lands in Phase 3; the phase-2 criterion is only that credentials are accepted).
    5. Report any breakage to the executor (fix cycle), then mark 03-SUMMARY.md done.
  </verify>
  e2e-auth.sh all green on the deployed URL; user confirms web vault accepts the e2e credentials; signups re-closed.
  <done>Live auth verified; web vault login checkpoint passed; phase 2 success criteria met.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green off-deploy
- Live: e2e-auth.sh green; web vault login accepted (human)
- securityStamp bump (manual, via forced test) revokes sessions — constant-time compare everywhere
</verification>

<success_criteria>
- Phase 2 (ROADMAP): register → prelogin (both shapes) → token → refresh → logout all verified live
- Wrong password → 400 invalid_grant; web vault login page accepts credentials
- Rate limiting active (tuning deferred to Phase 7)
</success_criteria>

<output>
After completion, create `.planning/phases/02-identity-auth/03-SUMMARY.md` and update `.planning/STATE.md`.
</output>