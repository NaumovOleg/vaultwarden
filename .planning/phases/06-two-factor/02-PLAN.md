---
phase: 06-two-factor
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/endpoints/two-factor.ts, src/endpoints/identity.ts, src/handler.ts, test/two-factor.test.ts]
autonomous: true

must_haves:
  truths:
    - "Email provider (1): POST /api/two-factor/get-email {masterPasswordHash} → {enabled, email, object:'twoFactorEmail'}; POST /api/two-factor/send-email {email} (setup code; no-email mode: code returned in body, documented); POST /api/two-factor/send-email-login (re-send during login; takes TwoFactorToken, returns fresh code); POST|PUT /api/two-factor/email {masterPasswordHash, email, token} → enable"
    - "Login email 2FA: TwoFactorProviders ['1'], TwoFactorProviders2 {'1': {Email: <masked>}}; the setup/login codes are 6-digit, stored as TFA# items with provider 1, consumed on verify"
    - "Two providers enabled → login lists both ['0','1']; the second-stage validation accepts the code for ANY enabled provider (client sends twoFactorProvider)"
    - "twoFactorEnabled on UserItem = (totpSecret != null) OR (email2fa set); both providers must appear in GET /api/two-factor"
  artifacts:
    - "email provider enable + login path + tests"
  key_links:
    - "TFA# items already carry providers[] — extend to hold the email code + provider for login-stage validation"
---

<objective>
Add the email 2FA provider (no-email mode returns the code in the response) and multi-provider login.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/research/API-SURFACE.md (§2.9)
@src/endpoints/two-factor.ts
@src/endpoints/identity.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: email provider endpoints</name>
  <files>src/endpoints/two-factor.ts, src/handler.ts</files>
  <action>
    - UserItem gets email2fa: {enabled: boolean, email: string} — keep as two fields: email2faEnabled: boolean, email2faAddress: string | null (masked for display)
    - get-email → {enabled, email: maskedEmail, object:'twoFactorEmail'}
    - send-email {email} → generate 6-digit code, store TFA#{token} item {code, provider:1, userId}, return {email: masked, code} (no-email: code in response body — document as extension; do NOT mask in the response so setup works)
    - send-email-login {twoFactorToken?} → re-issue code against the pending login's TFA# item (provider 1), return {code}
    - PUT|POST /api/two-factor/email {masterPasswordHash, email, token} → verify code → enable email2faEnabled=true, address=email, twoFactorEnabled=true
    - disable via POST /api/two-factor/disable {masterPasswordHash, type:1}
  </verify>
  jest: enable email → GET /api/two-factor shows both providers when TOTP also on
  <done>Email provider endpoints live.</done>
</task>

<task type="auto">
  <name>Task 2: multi-provider login + tests</name>
  <files>src/endpoints/identity.ts, test/two-factor.test.ts</files>
  <action>
    - TwoFactorProviders/TwoFactorProviders2 built from enabled providers (TOTP → '0'/'0':null; email → '1'/'1':{Email: masked})
    - validation order per twoFactorProvider form field (or Auth-2FA-Provider): 0 → TOTP code; 1 → email code from TFA# item (consume); legacy fallback tries TOTP then email then recovery
    - send-email-login flow: client calls it after the 200-challenge to receive the code (since no email transport); code returned verbatim
    - tests: enable both → challenge lists both → login with TOTP code works; login with email code works; email code consumed after use (second attempt with same code fails)
  </verify>
  `npm test` green
  <done>Both providers usable at login.</done>
</task>

</tasks>

<verification>
- `npm test` + tsc green
- disabled-email-2FA account degrades: email2fa disabled → providers list only shows authenticator
</verification>

<success_criteria>
- web vault 2FA settings page: authenticator + email rows work (email shows the code because no mail server — documented)
- login challenge for either provider completes
</success_criteria>

<output>
After completion, update .planning/STATE.md.
</output>
