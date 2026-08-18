---
phase: 06-two-factor
plan: 03
type: execute
wave: 3
depends_on: [02]
files_modified: [src/endpoints/identity.ts, src/endpoints/two-factor.ts, src/endpoints/accounts.ts, src/store.ts, test/two-factor.test.ts, scripts/e2e-vault.sh, .planning/STATE.md]
autonomous: true

must_haves:
  truths:
    - "securityStamp rotation (password/kdf change, disable-2FA does NOT rotate) already revokes sessions — verify 2FA bypass via remembered devices is impossible after stamp rotation"
    - "POST /api/two-factor/disable {masterPasswordHash, type} with only one provider enabled requires masterPasswordHash (have it) — disabling the LAST provider clears twoFactorEnabled"
    - "profile/sync twoFactorEnabled reflects state; DELETE /api/two-factor/authenticator and disable(type 0) keep email provider intact if enabled"
    - "e2e-vault.sh gets a step: enable TOTP → logout → login → 2FA 200-shape → code login"
  artifacts:
    - "stamp-rotation × 2FA regression test, disable-last-provider test, e2e step 15, phase summary + STATE.md"
  key_links:
    - "rotateSecurityStamp in accounts.ts already cascades sessions (deleteSessionsForDevice)"
---

<objective>
Harden the 2FA surface: disable semantics, stamp-rotation interplay, e2e step, and phase wrap.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/research/API-SURFACE.md (§2.9)
@src/endpoints/identity.ts
@src/endpoints/two-factor.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: disable semantics + stamp interplay</name>
  <files>src/endpoints/two-factor.ts, src/endpoints/accounts.ts, src/endpoints/identity.ts</files>
  <action>
    - disable {type}: 0 → clear TOTP + its recovery hashes; 1 → clear email; recompute twoFactorEnabled = (totpSecret ?? email2faEnabled)
    - disabling a provider that is NOT enabled → 400; unknown type → 400
    - regression: enable TOTP + remember device → rotate security stamp (POST /api/accounts/security-stamp) → old session invalid (already covered) AND login from the remembered deviceId requires 2FA again (device remember flag must not survive stamp rotation: clear twoFactorRemembered on all devices during stamp rotation — check rotateSecurityStamp / changePassword / changeKdf)
  </verify>
  jest: remembered-device bypass dies after security-stamp rotation
  <done>Disable + rotation semantics locked.</done>
</task>

<task type="auto">
  <name>Task 2: e2e + phase wrap</name>
  <files>scripts/e2e-vault.sh, .planning/phases/06-two-factor/03-SUMMARY.md, .planning/STATE.md</files>
  <action>
    - e2e step 15: enable authenticator via API (get-authenticator → need a valid TOTP code: compute client-side with openssl in the script? No — enable accepts token=code; generate the code in bash: python3 one-liner HOTP/TOTP using hmac+base64 → enable → re-login → expect 200 two-factor body → second login with code → access_token
    - 03-SUMMARY.md with owner handoff (deploy, web-vault 2FA settings check, authenticator + email rows, recovery codes)
  </verify>
  `bash -n`; `npm test`; tsc green
  <done>Phase 6 wrapped.</done>
</task>

</tasks>

<verification>
- `npm test` + tsc + `bash -n scripts/e2e-vault.sh` green
- disable-last-provider leaves twoFactorEnabled=false; login without code works
</verification>

<success_criteria>
- Full TOTP + email 2FA roundtrip from the web vault settings page; recovery codes printed once; remembered device bypass; stamp rotation revokes bypass
</success_criteria>

<output>
After completion, update .planning/STATE.md and write the phase summary.
</output>
