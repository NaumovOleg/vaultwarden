# Phase 6 — 2FA & Security: SUMMARY

## What shipped

Plans 01–03, commits 02c2d5c, f74a821, 996e408, + plan-03 commit. 133 tests green, tsc clean.

- **TOTP (RFC 6238)**: `totpSecret()` (52-char base32), `totpCode()`, `totpVerify()` ±1 window in `src/crypto.ts`; RFC vector verified (287082 @ T=59). Pending-key flow matches vaultwarden: `get-authenticator` mints a key, `authenticator` enables only with that key + valid code.
- **Recovery codes**: 5× `XXXXX-XXXXX` generated on first enable, stored as SHA-256 hashes; `get-recover` returns the hashes (vaultwarden-compatible — login accepts the code or its hash, so displayed strings work); cleared on disable.
- **Login challenge** (`connect/token`): providers listed (`TwoFactorProviders` ints + `TwoFactorProviders2` keyed objects), single-use `TwoFactorToken` (5 min TTL), code validated per provider, `twofactorremember=1` + legacy `Auth-2FA`/`Auth-2FA-Remember` headers supported. Wrong code → same `invalid_grant` as bad password (no user enumeration, rate limit untouched).
- **Email provider**: `get-email` / `send-email` (setup code) / `send-email-login` / `email` enable; address stored masked (`u***@example.com`). **No email transport** — the code is echoed in the API response and logged (ponytail-deferred: swap for SES/mail provider when shipping).
- **Disable semantics**: `DELETE /api/two-factor/authenticator` and `POST /api/two-factor/disable {type}` both password-gated; disabling a provider that is not enabled → 400; last-provider-off clears `twoFactorEnabled` and plain login works again.
- **Remember device vs stamp rotation**: `twoFactorRemembered` device flag is cleared by all three rotations (password change, kdf change, security-stamp) — a remembered device never survives a session revocation.
- **e2e-vault.sh step 15**: enable TOTP via API with a python-computed code → challenge → TOTP login → disable.

## Key decisions

1. Provider ids are integers (0=authenticator, 1=email) in `TwoFactorProviders`, string-keyed objects in `TwoFactorProviders2` — matches vaultwarden exactly.
2. Email codes are stored plaintext (short TTL) vs recovery hashes — acceptable: 6-digit, 5-min TTL, single slot per user; TOTP secret is the long-lived secret.
3. Duo/YubiKey/WebAuthn are deliberately absent (stretch per requirements; Duo needs a redirect flow, YubiKey needs an OTP validation callback, WebAuthn needs attestation). Web vault renders their rows disabled — no crash.

## Owner handoff (run after `npm run webvault && npx cdk deploy`)

1. `bash scripts/e2e-vault.sh https://<domain>` — step 15 proves the TOTP wire flow end-to-end.
2. Web vault → Settings → Security → Two-step Login:
   - Authenticator: enable → scan QR → 6-digit code → saved; "View recovery codes" shows 5 codes.
   - Email: enable with the displayed setup code (shown in the Lambda logs — CloudWatch `[2fa] email code for ...`).
   - Both enabled → logout → login shows both providers; complete login with either.
3. Remember-device: check "Remember this device" on the 2FA dialog → logout → login skips 2FA on that device.
4. Disable authenticator → plain login works.

## Known ceilings (ponytail-flagged)

- No email transport (codes echoed/logged). Add SES when real email lands.
- Recovery codes displayed as hashes (vaultwarden behavior; slightly ugly but functional).
- WebAuthn/Duo/YubiKey: out of scope, documented in RESEARCH/API-SURFACE §2.9 as stretch.