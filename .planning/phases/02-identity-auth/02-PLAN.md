---
phase: 02-identity-auth
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/endpoints/identity.ts, src/auth.ts, src/store.ts, src/handler.ts, src/errors.ts, src/crypto.ts, test/endpoints-auth.test.ts, test/auth.test.ts]
autonomous: true

must_haves:
  truths:
    - "POST /identity/connect/token password grant (wrong password) → 400 {\"error\":\"invalid_grant\",\"error_description\":\"Username or password is incorrect.\"} — never 401"
    - "Successful token response is byte-perfect per API-SURFACE §1.1 (opaque tokens instead of JWTs — clients treat them as opaque)"
    - "refresh_token rotates on every refresh; old refresh token dies"
    - "2FA-enabled account login returns HTTP 200 with the Two-factor-required envelope (exact shape), not an error status"
    - "Logout (endsession) deletes the session; refresh with a deleted/rotated token → 400 invalid_grant"
  artifacts:
    - "src/auth.ts (session issue/refresh/revoke, password verification, ratelimit)"
    - "SESS#{token} items with TTL; TFA#-typed 5-min items for 2FA tokens"
    - "test/auth.test.ts"
  key_links:
    - "password grant → GSI1 email → verifyPassword → twofactor_auth gate → session pair + device upsert"
    - "refresh grant → SESS#{refresh} GetItem → stamp/device check → rotate pair"
    - "every session item carries stamp snapshot; every authenticated read 401s on stamp mismatch"
---

<objective>
Implement token issuance: the `connect/token` chokepoint with password + refresh grants, the 2FA-required response shape, rate limiting, and logout.

Purpose: this is the single most delicate wire surface (pitfall 1.3) — byte-perfect response or clients fail login. Sessions are opaque in DynamoDB per the locked decision.
Output: working login/refresh/logout against the store, fully unit-tested.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§1.1, §1.2, §3.1, §3.2)
@.planning/research/PITFALLS.md (§1.3, §1.4, §1.6, §2.9)
@.planning/research/ARCHITECTURE.md (§5 token design)
@src/endpoints/identity.ts
@src/store.ts
@src/crypto.ts
@src/handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: session + password verification core</name>
  <files>src/auth.ts, src/store.ts, src/crypto.ts</files>
  <action>
    `src/auth.ts` (no deps beyond node:crypto + store):
    - `issueSession(user, deviceId): Promise<{accessToken, refreshToken, accessExpiresIn, refreshExpiresIn}>` — access 1h TTL, refresh 30d TTL; items `SESS#{token}|TOKEN` with `{userId, deviceId, type: 'access'|'refresh', stamp: user.securityStamp, ttl}` (ARCHITECTURE §5: stamp snapshot is the revocation mechanism). Delete-rotate: when a refresh is issued, delete the previous pair of that device so rotation is explicit.
    - `verifyAccessToken(store, token, userGetter)` → session or null (used from Plan 03's Bearer middleware; implement now with tests).
    - `verifyPassword(user, clientHash)` — `verifyPassword` with the user's stored salt + `passwordIterations`; returns boolean (pure function of the crypto module).
    - `rateLimit(store, ip, email)` — fixed-window counter: item `RATE#{ip}|LOGIN`, increment on each failed login (`recordFailedLogin`), threshold 10 failures/minute → `BitwardenError(429, 'Too many login attempts. Try again later.')`; success clears (`clearFailedLogins`). TTL on the rate item (1 min). Tuning deferred to Phase 7 (roadmap).
    - Store: add `rate` methods to the interface + MemoryStore/DynamoStore impls (DynamoStore: UpdateItem with `ADD` on a counter + ttl).
  </verify>
  ts-node smoke: issue → verify OK with same token+stamp, null after stamp change; rate limit blocks the 11th consecutive failure and clears on success. `tsc --noEmit` green.
  <done>Session primitives + ratelimit exist and behave; store interface complete for the token endpoints.</done>
</task>

<task type="auto">
  <name>Task 2: connect/token — password and refresh grants</name>
  <files>src/endpoints/identity.ts, src/handler.ts, src/errors.ts</files>
  <action>
    `POST /identity/connect/token` — form-encoded (parseBody: handle BOTH form-urlencoded and JSON bodies — some SDK clients send JSON), case-insensitive field names (lowercase keys after parse).
    - NEVER reject unknown headers or fields (pitfall 1.3: accept Auth-Email, X-Client-Type, X-Device-Type, X-Client-Version, deviceType/deviceIdentifier/deviceName/devicePushToken form fields for all grants).
    - `grant_type=password`:
      - Validate: `scope` contains `api offline_access` (AuthMethod::Password.check_scope — accept default scope when absent for web vault), username, password hash. Missing required → 400 `{"error":"invalid_grant","error_description":"..."}`.
      - rateLimit first (check_limit_login is first in vaultwarden).
      - GSI1 email lookup → missing → same 400 as wrong password (no user enumeration).
      - Account disabled (`enabled !== true`) → 400 `"This user has been disabled"`.
      - Accept BOTH `password` and `masterPasswordHash` forms and the `MasterPasswordHash` field name (pitfall 1.4 — Android 2025.12+); `password` field name wins if both present. `masterPasswordAuthentication` (newer shape with hash+kdf+salt) also accepted for login? — NO: that is registration-only; login hash arrives in `password`/`masterPasswordHash`. Verify with `verifyPassword` (constant-time). Wrong → 400 exact body (must_haves).
      - `auth_request` field: passwordless path is Phase 5 territory (auth-requests endpoints) — if present, 400 `invalid_grant` "Auth request not found." for now; do NOT treat it as a password.
      - User unverified (email verification gating): our phase has no email → skip mail-gating entirely (already null `verifiedAt` semantics — do not block).
      - 2FA gate (the shape must exist NOW even though no provider can be enabled until Phase 6 — code path + tests via forced flag):
        - if user has any 2FA enabled (Phase 6 field; today always none) OR test-forced → return the exact Two-factor-required envelope: HTTP 200, body `{"error":"invalid_grant","error_description":"Two factor required.","TwoFactorProviders":[...],"TwoFactorProviders2":{...},"MasterPasswordPolicy":{"Object":"masterPasswordPolicy"}}` (per-api-surface §1.2; provider ints as STRINGS; `TwoFactorProviders2` always present), plus a one-time `twoFactorToken` — store as `TFA#{token}|TOKEN` item (5-min TTL) linking userId+deviceId+provider list; return its value in a `TwoFactorToken` field inside the SAME 200 body (verified against vaultwarden identity.rs at execution time — `twofactor_auth` returns it in the body; re-check exact placement: body field `TwoFactorToken`).
        - second call with `twoFactorToken` + `twoFactorProvider` (form fields, modern clients) OR legacy headers (`Auth-2FA`+`Auth-2FA-Remember`+`X-Requested-With`) → validate TFA# item still valid → proceed to issue; consume (delete) the TFA item. Provider validation itself (TOTP/email codes) = Phase 6; Phase 2 accepts a matching twoFactorToken whose TFA# item exists — provider match recorded but not validated (nothing can enable 2FA yet, so this path is structural).
      - Device upsert: `get_device` semantics — device keyed `USER#{userId}|DEV#{deviceId}` from `deviceIdentifier`; store `name`/`type`(int)/`pushToken`, mark `lastUsed`; new device flag affects only push/email paths (none in Phase 2) — just upsert.
      - Issue session pair + build response:
        `{access_token, expires_in: 3600, token_type: "Bearer", refresh_token, Key: user.akey, PrivateKey: user.privateKey, Kdf: kdfType, KdfIterations, KdfMemory, KdfParallelism, ResetMasterPassword: false, ForcePasswordReset: false, ApiKeyClientSecretHint: null, securityStamp, passwordlessLogin: false}` — plus `TwoFactorToken` when the 2FA gate was just passed. Field names EXACT (PascalCase for Kdf* per API-SURFACE §1.1). Include `TwoFactorProviders: null` on success? — omit when not 2FA-required (per pitfall 1.3: only when 2FA required, `null` otherwise — include as null, mirror vaultwarden's `authenticated_response` at execution time).
    - `grant_type=refresh_token`:
      - GetItem `SESS#{refreshToken}` → null → 400 `{"error":"invalid_grant"}` (clients match this exact minimal body — refresh_login in identity.rs).
      - type must be `refresh`; deviceId check (client_id/device fields may be absent — tolerate); **stamp check**: roll up `USER#{id}|PROFILE`, compare `securityStamp` → mismatch → delete session → 400 invalid_grant (pitfall 2.9).
      - Rotate: delete old pair (access+refresh), issue new pair, update device lastUsed.
      - Response: same full shape as password grant.
    - `POST /identity/connect/endsession` → delete the session pair (token from form field `refresh_token` or access token); 200 `{}`. (vaultwarden does not expose endsession — mirror: execute-time verification against identity.rs `routes()`; if vaultwarden lacks it, implement as OAuth-revocation-compatible endpoint that never errors, since web vault's logout calls it.)
  </verify>
  `npm test` green. ts-node smoke (MemoryStore): register → password grant (exact body assert incl. field order-independent) → refresh → rotation (old refresh now 400s) → endsession → logged-out 400; wrong password exact body; rate limit 429 after 10 fails; 2FA forced-flag path → 200 envelope exact shape.
  <done>Token issuance, rotation, revocation, 2FA gate shape, ratelimit all implemented and asserted byte-for-byte.</done>
</task>

<task type="auto">
  <name>Task 3: endpoint wiring + tests</name>
  <files>src/handler.ts, src/endpoints/identity.ts, test/auth.test.ts, test/endpoints-auth.test.ts</files>
  <action>
    Wire the token + endsession routes into `createHandler` (identity routes unauthenticated). Keep `routes` list explicit. Verify the response `Content-Type` is `application/json` on all identity JSON (pitfall 1.8: charset matters to iOS — use `application/json; charset=utf-8`).

    `test/auth.test.ts` (the token protocol suite, MemoryStore):
    1. happy path: register → password grant → assert EVERY field of the response (must_haves shape) → refresh → new pair, old refresh 400 `{"error":"invalid_grant"}` exact minimal body → GET-free stamp check via force-stamp-change → refresh → 400 → endsession → old access session deleted (verifyAccessToken null).
    2. wrong password → exact 400 body; missing username → 400 invalid_grant; disabled user → disabled message.
    3. unknown email + wrong password → IDENTICAL responses (no enumeration).
    4. 2FA forced flag: first call → 200 envelope with TwoFactorProviders/TwoFactorProviders2/MasterPasswordPolicy + TwoFactorToken; second call with form field `twoFactorToken`+`twoFactorProvider` → full success; legacy header variant (`X-Requested-With` + `Auth-2FA` + `Auth-2FA-Remember`) → success; replaying the consumed TFA# token → invalid_grant.
    5. rate limit: 10 failures → 11th blocked 429; success clears counter.
    6. legacy field names: `MasterPasswordHash` in body works; `password` works; both → `password` wins.
  </verify>
  `npm test` fully green; `tsc --noEmit` green; `npm run synth` green (no stack change → proves handler-only diff).
  <done>Full login protocol suite green; byte-exact response asserted; rotation/revocation semantics proven.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- Manual smoke matrix (ts-node, no deploy): register → prelogin → token → refresh → logout; wrong password → 400 invalid_grant; 2FA shape → 200 envelope (forced)
- SESS# items carry stamp snapshots; TFA# items are 5-min TTL and single-use
</verification>

<success_criteria>
- Password login, refresh rotation, and logout work end-to-end on the store
- Every failure mode returns the Bitwarden wire shape — never a Lambda error, never 401 where clients expect 400
- Wave 2 complete: Plan 03 can add bearer-auth'd devices + the verification harness
</success_criteria>

<output>
After completion, create `.planning/phases/02-identity-auth/02-SUMMARY.md`
</output>