---
phase: 06-two-factor
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/store.ts, src/endpoints/two-factor.ts, src/endpoints/identity.ts, src/endpoints/accounts.ts, src/handler.ts, test/two-factor.test.ts]
autonomous: true

must_haves:
  truths:
    - "TOTP (provider 0): GET /api/two-factor, POST /api/two-factor/get-authenticator {masterPasswordHash} → {enabled,key,object:'twoFactorAuthenticator'}, POST|PUT /api/two-factor/authenticator {masterPasswordHash,key,token} (enable/re-key, token must verify against key), DELETE /api/two-factor/authenticator {masterPasswordHash} (disable)"
    - "Recovery codes: POST /api/two-factor/get-recover {masterPasswordHash} → regenerates 5 codes, returns them (vaultwarden semantics), stores SHA-256 hashes; a recovery code logs in via the same 2FA slot"
    - "Login 2FA: first /connect/token → 200 {'error':'invalid_grant','error_description':'Two factor required.','TwoFactorProviders':['0'],'TwoFactorProviders2':{'0':null},'TwoFactorToken':<opaque>,MasterPasswordPolicy}; second call sends twoFactorToken=opaque+twoFactorCode=<code> OR twoFactorToken=<code> directly (legacy), twoFactorProvider='0', twoFactorRemember=0|1"
    - "Provider ints (canonical): 0 authenticator, 1 email, 2 duo, 3 yubikey, 7 webauthn — do NOT trust the research-note at API-SURFACE §1.2 (its '3'=email comment is wrong)"
    - "Remember: twoFactorRemember=1 or Auth-2FA-Remember header → mark the device; later logins from that deviceId skip 2FA until securityStamp changes"
  artifacts:
    - "TOTP + recovery + remember-device login flow, tests green"
  key_links:
    - "existing TFA# token plumbing in identity.ts passwordGrant (TwoFactorToken issuance + verification) is reused"
    - "DeviceItem gets twoFactorRemembered flag (sk DEV#{deviceId} already upserted at login)"
---

<objective>
Ship the authenticator (TOTP) 2FA provider end to end: setup endpoints, recovery codes, login challenge with the exact 200-shape, and remember-device.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§1.2, §2.9)
@src/endpoints/identity.ts
@src/store.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: store + TOTP core</name>
  <files>src/store.ts, src/crypto.ts</files>
  <action>
    - UserItem stays as-is (twoFactorEnabled already there); add TwoFactorProviderItem? No — store on user row: totpSecret (base32), totpEnabled implicit via twoFactorEnabled? Keep explicit: `totpSecret: string | null` on UserItem, recovery hashes as `TFA#{userId}` sk `RECOVER#{hash}` rows
    - store methods: putRecoveryHash(userId, hash), listRecoveryHashes(userId) (sk begins_with 'RECOVER#'), deleteRecoveryHash(userId, hash); DeviceItem.twoFactorRemembered: boolean (upsert keeps it)
    - src/crypto.ts: totpSecret() → 32-char base32 (A-Z2-7, no padding); totpCode(secretB32, whenMs) → 6-digit RFC-6238 (HMAC-SHA1, 30s window, SHA1 (key, counter) big-endian, 8-byte dynamic truncation); totpVerify(secret, code, window=1) → bool (checks ±1 step); base32Decode/Encode helpers; recoveryCode() → 'XXXXX-XXXXX'; recoveryHash(code) → sha256 hex
  </verify>
  ts-node smoke: totpCode/verify roundtrip + known RFC-6238 test vector (RFC 6238 appendix: secret GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, T=59s → 287082)
  <done>TOTP primitives verified against RFC vector.</done>
</task>

<task type="auto">
  <name>Task 2: two-factor endpoints</name>
  <files>src/endpoints/two-factor.ts, src/handler.ts, src/endpoints/accounts.ts</files>
  <action>
    - two-factor.ts with requirePassword helper (masterPasswordHash must verify)
    - GET /api/two-factor → {object:'twoFactor', enabled, providers: user.twoFactorEnabled?[0]:[], totp: {enabled,...}|null, email: null, duo: null, yubikey: null, webauthn: null}
    - POST get-authenticator {masterPasswordHash} → {enabled: false, key: <fresh base32>, object:'twoFactorAuthenticator'}
    - POST|PUT /api/two-factor/authenticator {masterPasswordHash, key, token} → totpVerify(key, token) or 400; set user.totpSecret=key, twoFactorEnabled=true; get-recover codes generated at first enable
    - DELETE /api/two-factor/authenticator {masterPasswordHash} → clear totpSecret, twoFactorEnabled=false, delete recovery hashes
    - POST /api/two-factor/get-recover {masterPasswordHash} → regenerate 5 codes (delete old hashes, put new), return {codes, object:'twoFactorRecover'}
    - POST|PUT /api/two-factor/disable {masterPasswordHash, type} → single-provider disable (type 0)
    - routes in handler.ts (exact + param-free paths only)
  </verify>
  jest: enable with wrong token → 400; enable with valid token → GET /api/two-factor shows enabled, providers [0]; delete → disabled; recovery regenerate returns 5 codes
  <done>Provider endpoints live.</done>
</task>

<task type="auto">
  <name>Task 3: login challenge + remember + tests</name>
  <files>src/endpoints/identity.ts, test/two-factor.test.ts</files>
  <action>
    - passwordGrant: when user.twoFactorEnabled and no 2FA creds: TwoFactorProviders ['0'], TwoFactorProviders2 {'0': null}, MasterPasswordPolicy {Object:'masterPasswordPolicy'}, TwoFactorToken opaque (reuse existing TFA# plumbing)
    - second stage: accept (a) opaque twoFactorToken + twoFactorCode, (b) opaque twoFactorToken + code in Auth-2FA header, (c) code directly as twoFactorToken (legacy); provider from twoFactorProvider form field or Auth-2FA-Provider header; validate: TOTP code, then recovery hash match; consume TFA# token when present; wrong → INVALID_GRANT
    - remember: form twoFactorRemember=1 or Auth-2FA-Remember=1 → device.twoFactorRemembered=true after success; subsequent password grants from same deviceId skip the challenge (regardless of stamp change on disable only? no: remember persists until user disables 2FA — vaultwarden semantics: remembered device bypasses 2FA until password change/security stamp rotation)
    - twoFactorEnabled on UserItem must be true for email provider later (plan 02)
    - test/two-factor.test.ts: enable → login 1 (200, TwoFactorProviders ['0']) → login 2 with code → access_token; wrong code → 400 invalid_grant; recovery code login; remember device: second login from same deviceId skips 2FA; disable → plain login works
  </verify>
  `npm test` green; tsc green
  <done>Authenticator 2FA fully works in tests.</done>
</task>

</tasks>

<verification>
- `npm test` + `npx tsc --noEmit` green
- RFC-6238 vector passes in crypto test
- wrong-code path returns 400 invalid_grant (clients match this)
</verification>

<success_criteria>
- SDK flow: enable TOTP → login hits 200 two-factor shape → completes with code → access_token; recovery code path works; remembered device skips challenge
</success_criteria>

<output>
After completion, update .planning/STATE.md.
</output>
