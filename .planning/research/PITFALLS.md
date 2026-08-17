# Bitwarden Server API Reimplementation — Client Compatibility Pitfalls

Research for: TypeScript + AWS Lambda + DynamoDB reimplementation of the Bitwarden server API
(goal: real Bitwarden clients work: Web Vault OSS, iOS/Android, desktop, browser extension).
Reference: Vaultwarden (Rust). Research only — no code written.

**Meta-finding first:** Bitwarden officially does *not* support alternate servers, so every
compat break is discovered by the community after the fact (Vaultwarden maintainers track
them as "Bitwarden released new clients that broke compatibility" cycles — every client
release since ~v2023.1 has had at least one server-side fix required on Vaultwarden's side).
Bitwarden's own support policy: each client version is only guaranteed compatible with
servers of the same major version ± 2 major versions
(https://bitwarden.com/help/bitwarden-software-release-support/). A reimplementation is
always chasing a moving target: the *client* fleet is the spec.

---

## Category 1 — CLIENT-KILLERS (login/sync/unlock broken; app unusable)

### 1.1 New-prelogin endpoint: `POST /identity/accounts/prelogin/password` (missing → 404 → "login failed")

- **Affected:** Browser extension, desktop app, web vault; new clients from v2026.4.0 onward.
- **Symptom:** Fresh installs/incognito logins fail with generic "username or password
  incorrect" / "Unexpected error"; *already-logged-in* sessions keep working, so servers
  appear healthy. Server log shows `404 Not Found` for `POST /identity/accounts/prelogin/password`.
- **Mechanism:** The 2026.x clients split prelogin into a password-preparation call that old
  servers don't route. Vaultwarden 1.36.0 added the endpoint; anything older hard-fails new
  clients. Vaultwarden 1.36's fix routes it to the existing prelogin handler — the new route
  returns the same KDF info as `POST /identity/accounts/prelogin`.
- **Correct implementation:** Serve BOTH `POST /identity/accounts/prelogin` and
  `POST /identity/accounts/prelogin/password` forever; both must return the account's KDF
  parameters (see 1.2). Never return 404 for unknown identity routes used by login flows —
  log and map legacy routes before dropping them.
- Sources: https://github.com/dani-garcia/vaultwarden/issues/7223 ,
  https://github.com/dani-garcia/vaultwarden/discussions/7279 ,
  https://blog.margrop.net/en/post/chrome-bitwarden-vaultwarden-login-failure-prelogin ,
  https://github.com/community-scripts/ProxmoxVE/issues/14721

### 1.2 Prelogin KDF response shape: `kdfConfig` vs legacy `kdf`+`kdfIterations` → "KDF config is required"

- **Affected:** Browser extension (new Rust/WASM SDK clients, ~2025+) and new mobile clients;
  arrows above all hit Argon2id accounts worst.
- **Symptom:** After entering master password: `Error: KDF config is required` (Chrome) or
  "Invalid master password" (Firefox); no prelogin request may even appear in server logs when
  the client aborts early; mobile app app crashes right after login.
- **Mechanism:** Legacy servers returned `kdf: 0 (PBKDF2)` + `kdfIterations: N` only. The SDK
  clients require a *structured* `kdfConfig` object (algorithm + all parameters, including
  Argon2id memory/iterations/parallelism) in the prelogin response, keyed by the account's
  actual algorithm. If absent/malformed → hard error. Vaultwarden needed releases to satisfy
  browsers (1.34.x → 1.35.x era) and Vaultwarden's own forum thread "Error: KDF config is
  required" shows Chrome/Firefox behavior differs (https://vaultwarden.discourse.group/t/error-kdf-config-is-required/4899).
- **Correct implementation:** prelogin (both routes, see 1.1) and the token response (see 1.3)
  must emit the account's KDF algorithm and full parameters (PBKDF2: iterations ≥600k default;
  Argon2id: memory=64MB / iterations=3 / parallelism=4 defaults, *exactly* what the server
  stored for that user). Serialize `kdfConfig` AND keep the legacy `kdf`/`kdfIterations`
  fields for old clients — return both.
- Related: Bitwarden KDF help notes the client-side default is 600,000 PBKDF2 and Argon2id
  defaults https://bitwarden.com/help/kdf-algorithms
- Sources: https://vaultwarden.discourse.group/t/error-kdf-config-is-required/4899 ,
  https://github.com/bitwarden/clients/issues/13966

### 1.3 `POST /identity/connect/token` response must be byte-perfect: 2FA shape, error shape, headers

- **Affected:** All clients (token is the login chokepoint).
- **Symptom classes seen in the wild:**
  - iOS: `BitwardenKit.ResponseValidationError(... statusCode: 400 ...)` — the iOS app
    strictly validates token responses; a wrong-shaped 400 body fails differently than the
    expected `{"error":"invalid_grant","error_description":"..."}`
    (https://community.bitwarden.com/t/error-message-on-ios-app/86919).
  - "Auth-Email header invalid": clients ≥2025 send an `Auth-Email` header on
    identity/token; old self-hosted servers (2025.2.0) rejected it → login hard-fail for some
    users (https://community.bitwarden.com/t/problem-acessing-my-self-hosted-bitwarden-with-desktop-app-and-browser-extension/91289 ,
    https://github.com/bitwarden/clients/issues/17415).
  - Android: "Not a recognized Bitwarden server" when the server's responses don't match
    expected identity shapes (https://vaultwarden.discourse.group/t/android-not-a-recognized-bitwarden-server-error/).
- **Correct implementation (success payload, mirrored from Vaultwarden/`identity.rs`):**
  `access_token`, `expires_in` (~3600), `token_type:"Bearer"`, `refresh_token`,
  `Key`, `PrivateKey` (user's RSA/EC private key), `Kdf`, `KdfIterations`, `KdfMemory`,
  `KdfParallelism`, `TwoFactorProviders` (only when 2FA required, `null` otherwise),
  `TwoFactorProviders2` (always include, `null`), `CaptchaBypassToken` (null),
  `ResetMasterPassword` (bool), `ForcePasswordReset` (bool), `ApiKeyClientSecretHint`,
  `securityStamp` (must change on password/KDF change — this logouts all sessions),
  `passwordlessLogin` (bool).
  Accept `Auth-Email` and `X-Client-Type`/`X-Device-Type`/`X-Client-Version` headers; never
  reject unknown client headers.
  Errors: HTTP 400 with `{"error":"invalid_grant","error_description":"Username or password is incorrect."}`
  — do NOT return 401; clients treat 400+`invalid_grant` as the expected sign-in failure path.
- Sources: https://www.synacktiv.com/en/publications/forensic-analysis-of-bitwarden-self-hosted-server
  (token request/response captured), https://github.com/bitwarden/ios/pull/1694
  (invalid_grant handling on refresh), thread links above.

### 1.4 Android token field change: `MasterPasswordHash` (2025.12+) → "Missing the required MasterPasswordUnlock data property"

- **Affected:** Android app v2025.12.1+; Vaultwarden < 1.35.2.
- **Symptom:** Android logs in but then repeatedly prompts to "verify master password";
  stacktrace `MissingPropertyException: Missing the required MasterPasswordUnlock data
  property`; browser/web still fine. Clearing client session is not enough — the server must
  accept the new login payload, which changed which field carries the master-password hash
  and/or how it's derived for unlock.
- **Correct implementation:** parse the token request leniently for BOTH legacy
  `MasterPassword` and new `MasterPasswordHash` (and device-keyed auth request variants);
  verify the hash against the stored iterations; exactly reproduce Vaultwarden 1.35.2's
  "Android MasterPasswordHash support" behavior.
- Sources: https://forum.yunohost.org/t/bitwarden-android-app-not-working-with-vaultwarden-after-upgrade-13-01-2026/41382 ,
  Vaultwarden 1.35.2 release notes (WinterFlow catalog: https://winterflow.io/catalog/vaultwarden/releases)

### 1.5 `/api/sync` cipher payload strictness: 2026.7.0+ clients crash on non-canonical cipher shapes

- **Affected:** ALL 2026.7.0+ clients (extension, desktop, mobile); servers < Vaultwarden
  1.37.0 are incompatible; even on new servers, *legacy-shaped stored ciphers* still crash.
- **Symptom:** Vault shows empty / infinite loading skeletons after successful login; item
  list never renders (the WASM SDK aborts the whole vault render on the first bad item).
  Web Vault is more tolerant and still renders fine (its parser is different → misleading).
  Error: `Error: invalid type: JsValue(Object({...})), expected a string`.
- **Mechanism:** Since 2026.7.0 the clients' Rust/WASM SDK deserializes each cipher into a
  **strict typed struct**; cipher-type payload fields (`data`/per-type objects like Login's
  username/password/uris/totp) must have exactly the expected types. Historical Vaultwarden
  stored ciphers with the *entire* cipher JSON flattened into the type-payload column
  (name/notes/fields merged into `data`) — that shape now crashes strict parsers. Fix in
  Vaultwarden 1.37.0/1.37.1 was server-side (serialization normalization/`to_json` error
  handling, https://github.com/dani-garcia/vaultwarden/pull/7068 ), but pre-existing rows
  still break sync (community reports: upgrade alone doesn't fix old items).
  https://github.com/dani-garcia/vaultwarden/discussions/7464 ,
  https://github.com/bitwarden/clients/issues/22013
- **Correct implementation:** Storage must keep the *type payload* and *cipher-level fields*
  strictly separated (never fold `name`/`notes`/`fields`/`passwordHistory` into the login-
  object column). Serialize sync responses with canonical types (strings for encrypted
  values, numbers for enums, null or arrays for lists — see 2.5). Normalize/repair any
  legacy-shaped rows on read (like Vaultwarden's sync-time correction) rather than echoing
  stored data verbatim — "trust that clients send correct new data, correct old data at sync
  time" is Vaultwarden's stated strategy
  (https://github.com/dani-garcia/vaultwarden/wiki/Bitwarden-Android-troubleshooting).
  **Plan for client drift:** treat "empty vault / stuck sync after a client auto-update" as
  the #1 failure signature of a strict-parser change landing upstream.

### 1.6 KDF iterations semantics: double-hash, legacy 100k accounts, 600k enforcement

- **Affected:** All clients on accounts with non-default KDF; new clients from 2026.2.1
  enforce minimums.
- **Symptom:** "Invalid username or password" on accounts whose stored hash was produced with
  different iterations than the client used; mass "Update your encryption settings" prompts
  for <600k PBKDF2 accounts since client 2026.2.1
  (https://bitwarden.com/help/kdf-algorithms — "In the 2026.2.1 release, Bitwarden increased
  the minimum number of PBKDF2 KDF iterations to the default level, 600,000");
  KDF display inconsistency in Web Vault (Vaultwarden discussion #5111).
- **Mechanism:** The *client* derives a master-password hash at the account's KDF settings
  (announced via prelogin) and the *server* additionally hashes it with the stored
  iterations count (the "server-side iterations" design, Wladimir Palant's analysis:
  https://palant.info/2023/01/23/bitwarden-design-flaw-server-side-iterations ).
  If server default ≠ account setting, or server re-announces different values, hashes never
  match → login fails. Legacy accounts created with 100k must be re-hashed server-side when
  the user changes KDF; Vaultwarden increased its *default for new users* to 600k and
  rehashes on KDF change (https://github.com/dani-garcia/vaultwarden/discussions/5111 ).
- **Correct implementation:** Store per-user `kdf` + algorithm parameters at registration;
  announce them verbatim at prelogin/token; at KDF change endpoints, server rehash with the
  *new* parameters only after verifying the master key with the old ones; default new
  accounts to 600k PBKDF2 (or Argon2id defaults); accept any iteration count the user chose
  at login (enforcement of the 600k floor is a *client-side* policy; do not reject logins).

### 1.7 Web Vault / WebCrypto secure-context: HTTPS required in Chrome

- **Affected:** Web Vault; browser extensions using the web vault.
- **Symptom:** Web Vault won't load/unlock over plain HTTP in Chrome ("environment is not
  secure"); Vaultwarden serves the web vault over HTTPS only in practice.
- **Mechanism:** Web Vault requires the Web Crypto API → secure context → HTTPS (or
  localhost). Vaultwarden wiki: "Vault doesn't work in this configuration in Chrome"
  (https://github.com/bitwarden/web/issues/254,
  https://github.com/dani-garcia/vaultwarden/wiki/Differences-from-the-upstream-API-implementation).
- **Correct implementation:** For the API behind Lambda this is deployment, not code: put the
  API + hosted web vault behind HTTPS (API Gateway custom domain); keep `https:` absolute
  URLs in `data:{}` / icon URLs / redirects; verify `X-Forwarded-Proto` handling if you ever
  build absolute URLs server-side. Mobile "Connection failure" with no server log hits are
  usually TLS/reverse-proxy (see 1.8).

### 1.8 Mobile "Connection failure" / TLS & headers through the reverse proxy

- **Affected:** iOS/Android apps; browser extension.
- **Symptom:** `Exception message: Connection failure` on Android at username or password
  step; *no request ever reaches the server* (nginx logs empty)
  (https://vaultwarden.discourse.group/t/connection-failure-with-bitwarden-android-app/3442).
  Desktop app + extension work fine meanwhile.
- **Mechanism:** Mobile apps are the strictest TLS clients; they also choke on middleboxes
  (Authelia-style interceptors: https://vaultwarden.discourse.group/t/official-bitwarden-android-app-not-connecting-to-self-hosted-instance/3172
  — login failed through Authelia while sync worked; disabling it fixed login).
- **Correct implementation:** Serve proper TLS chain incl. intermediates; keep
  Content-Type `application/json; charset=UTF-8` on all API responses (iOS BitwardenKit logs
  show it expects charset); don't strip/rewrite `Auth-Email`, `X-Device-Type` etc. headers
  through the proxy.

### 1.9 Registration endpoint contract drift (`POST /api/accounts/register`)

- **Affected:** Web Vault (signup page is server-hosted) and mobile/desktop create-account.
- **Symptom:** New clients post fields old servers reject (400/422) → signup impossible; or
  account created with a hash/wrong key shape → login works but vault items decrypt to
  garbage in other clients.
- **Mechanism/notes:** Registration payload evolved: `masterPasswordHash` (v1) →
  `masterPasswordHash` + `key` + `keys{publicKey,encryptedPrivateKey}` (RSA, then EC P-256
  for new accounts) + KDF params; newer clients also send `sig`. Vaultwarden had register
  fixes through 2025 (e.g. 1.35.x "user API key login fix"). Bitwarden web vault register UI
  is served by the server itself, so the *server-hosted web vault version* dictates which
  payloads arrive (see 1.10).
- **Correct implementation:** Accept all historical field combinations; default the key
  algorithm to what the client sent (RSA-2048 or EC P-256 — see 2.3); never reject unknown
  extra fields on register. Longest-lived compat trick: be permissive on input, canonical on
  output.

### 1.10 Server-hosted Web Vault must be kept current

- **Affected:** Web Vault users.
- **Symptom:** Vaultwarden ships a *pinned, patched* web vault per release (1.36 ships web
  2026.4.1; old pinned web vaults show "update available" banner or break against newer
  server APIs; conversely too-new web vault against old server breaks — Bitwarden notes the
  web vault is packaged "with server" and continues to work if server not updated:
  https://bitwarden.com/help/november-deprecation-notice ).
- **Correct implementation:** Host the Web Vault OSS build that matches your API era; strip
  the version-update check (Vaultwarden patches it out); the web vault's API probe
  (`/api/version` returning e.g. `2026.4.1`) feeds third-party integrations too (e.g. Elastic
  integration reads it: https://github.com/elastic/integrations/issues/10022 ).

### 1.11 2FA-enabled accounts: provider endpoints must exist or login is blocked

- **Affected:** Any account with two-step login enabled; all clients.
- **Symptom:** Login returns the 2FA challenge; client POSTs the token to the provider's
  path (e.g. `/identity/two-factor` with provider id); missing endpoints → 400 "Two factor
  token not provided" loops
  (https://github.com/dani-garcia/vaultwarden/discussions/7329 ) or 404.
- **Correct implementation:** Implement the full 2FA surface: `TwoFactorProviders`/
  `TwoFactorProviders2` in token response; `POST /identity/two-factor` (authenticator,
  email, webauthn, yubikey, duo), plus 2FA management endpoints
  (`/api/two-factor`, per-provider `/two-factor/authenticator`, `/two-factor/email`,
  `/two-factor/webauthn`, `/two-factor/yubikey`, `/two-factor/duo`). Clock skew on TOTP
  validation must be forgiving (server time is used — "Invalid TOTP code! Server time: …" in
  Vaultwarden logs when the device clock differs).

### 1.12 Device registration & "known device" flow

- **Affected:** Mobile clients (2FA-skip on trusted devices), desktop/extension "login with
  device".
- **Symptom:** Every login asks for 2FA again (device not recognized) →
  `GET/POST /api/devices`, `GET /api/devices/knowndevice`,
  `PUT /api/devices/identifier/{id}/token` (mobile push token registration, 405/404 with EU
  push relay misconfig: https://github.com/dani-garcia/vaultwarden/issues/4609 ) missing →
  broken; auth-requests ("log in with device") require
  `POST /api/auth-requests` + `GET /api/auth-requests/{id}` with `masterPasswordHash: null`
  and `deviceIdentifier` fields; WebSocket negotiate
  (`/notifications/hub/negotiate`) for live sync.
  Auth-request payload contains `"key": "...", "masterPasswordHash": null, "deviceIdentifier": "...", "requestApproved": true`
  (https://github.com/dani-garcia/vaultwarden/discussions/3963 ).
- **Correct implementation:** Implement device CRUD keyed by device identifier; return the
  device list in sync; persist push tokens; serve `/notifications/hub/*` negotiate (see 2.6).

---

## Category 2 — MEDIUM (works, but feature broken or ugly UX)

### 2.1 `/api/sync` "domains" (global equivalent domains) → autofill/URI matching weakens
- **Affected:** All clients (autofill matching).
- Clients expect `profile` + `domains: {globalEquivalentDomains: [...]}` (and
  `equivalentDomains` from `/api/settings/domains`). Missing → `*.google.com`-style
  equivalent-domain matches fail; also clients fetch `/api/settings/domains` to overlay
  user-defined equivalents (Cozy reimplementation documents the endpoints:
  https://docs.cozy.io/en/cozy-stack/bitwarden ).
- **Implement:** return the default GED list verbatim from Bitwarden's list
  (`globalEquivalentDomains`, ids 0..~33) + honor user overrides.

### 2.2 `/api/accounts/revision-date` (ms epoch) — sync cadence driver
- **Affected:** All clients; affects freshness, not correctness.
- Clients poll `GET /api/accounts/revision-date` to decide whether a full `/api/sync` is
  needed; the value must *increase* on any vault mutation and be per-user. Wrong/stale values
  → clients sync too often or never notice changes (Cozy docs explicitly note "returned as a
  number of milliseconds since epoch (sic)" — the unit surprises reimplementers).
- Correct: return `accountRevisionDate` also in sync `profile`; keep both consistent.

### 2.3 Org/user asymmetric keys: RSA-2048 → EC P-256 drift; key rotation endpoints
- **Affected:** Organizations & sharing; newer clients.
- New-account keys are Elliptic Curve (P-256) for recent clients, RSA-2048 for legacy;
  org keys come from whichever client created them. Sync returns `keys.publicKey` +
  `keys.encryptedPrivateKey`; organization sync returns org `keys` + collection
  `encryptedKey`. Servers must store/echo keys verbatim and not assume RSA. Bitwarden's own
  docs describe device public-key encryption for trusted devices (TDE) — a
  user-key-encrypted device key register flow on login
  (https://bitwarden.com/help/bitwarden-security-white-paper). Vaultwarden discussion #3648
  shows the exact payload a client sends at org creation (`key`, `keys.encryptedPrivateKey`,
  `keys.publicKey`, RSA magic constant "4." for RSA-wrapped keys)
  (https://github.com/dani-garcia/vaultwarden/discussions/3648).
- Key rotation endpoints (`POST /api/accounts/keys/rotate`,
  `POST /api/accounts/password-reset`) must handle EC keys, `publicKey`/`encryptedPrivateKey`
  + new `Key`; old servers 2025.2- broke clients with keyed logins; official server 2025.1.3
  *forced* legacy-encryption-key users to log into the web app first and blocked other
  clients until migration (https://bitwarden.com/help/releasenotes — "Legacy user encryption
  key migration", self-hosting note). A reimplementation should support both key types plus
  the migration endpoints to avoid bricking pre-2021-era accounts.

### 2.4 Empty/absent keys in profile ("empty AccountKeys") breaks newer clients
- **Affected:** Web Vault (and desktop) with accounts lacking `keys`.
- Vaultwarden 1.35.2 fixed "empty AccountKeys" — accounts whose `keys` payload is empty
  object/missing cause newer clients to fail user-key operations (export, restore, org key
  wrapping, decryption of key-encrypted items).
  (https://winterflow.io/catalog/vaultwarden/releases)
- **Implement:** always emit `keys: {encryptedPrivateKey: string|null, publicKey: string|null}`
  as explicit keys; re-key older accounts on KDF/master-password change.

### 2.5 Null vs absent JSON fields — emit the explicit null
- **Affected:** New strict SDK clients; old clients tolerate both.
- Official commits: ciphers return `"Fields": null`, `"Attachments": null`,
  `"DeletedDate": null`, `"OrganizationId": null` etc. — *keys present with null values*,
  and `Login` object present for login ciphers (Cozy reimplementation shows the shape:
  https://docs.cozy.io/en/cozy-doctypes/docs/com.bitwarden.ciphers ,
  https://docs.cozy.io/en/cozy-stack/bitwarden ). Omitting keys entirely is what breaks
  strict deserializers (server "204 No Content response" fix in Vaultwarden 1.35.2 for org
  creation: endpoints must return 200 + body, not 204).
- **Implement:** mirror the official model: all documented fields always present;
  nullable ones null, not omitted; `DeletedDate` missing means not-quite-deleted — the "day 00"
  dates seen in exports (`YYYY-MM-00T00:00:00.000Z`) are client-export artifacts, server
  should never emit day-00 dates.

### 2.6 Live sync / push: WebSocket + mobile push relays
- **Affected:** Desktop/browser (live sync), mobile (push).
- Missing `/notifications/hub/negotiate` + `/notifications/hub` (WebSocket): clients fall
  back to periodic sync — works, but "instant" updates lag. Mobile push requires the client
  to register a token (`PUT /api/devices/identifier/{id}/token`) and the server to call the
  Bitwarden push-relay (`/api/push/lmbt` style) — absent → no push; "Login with device" /
  pending-2FA-request notifications dead (the *requests themselves* still work if
  `/api/auth-requests` is implemented).
  (https://github.com/dani-garcia/vaultwarden/wiki/Enabling-Mobile-Client-push-notification)
- **Note for Lambda:** a persistent WebSocket endpoint is not feasible on pure Lambda — that
  is acceptable (clients degrade to polling), but the negotiate endpoint should still exist
  and respond so clients don't error-spam.

### 2.7 Feature flags / `/api/config` and experimental items (SSH keys etc.)
- **Affected:** Feature-gated client UIs (SSH-key items, etc.).
- `/api/config` exposes feature flags; Vaultwarden ships `EXPERIMENTAL_CLIENT_FEATURE_FLAGS`
  (e.g. `ssh-key-vault-item,ssh-agent`) consumed by clients. New cipher types (SSH key item,
  added in Bitwarden 2024.12) arrive as new cipher **types**; servers that reject/ignore
  unknown types break item sync — must store & echo unknown cipher types verbatim and
  tolerate unknown field sets
  (https://idpea.org/blog/bitwarden-vaultwarden-ssh-keys , Vaultwarden 1.32.x support).
  Vaultwarden PR #7068 (`fix: return Err instead of panic on unknown cipher atype`) shows
  servers must not panic on unknown cipher types — return them as-is.

### 2.8 Server "version" signaling and the ±2-major compatibility window
- **Affected:** Clients that surface server-version warnings (Android
  "Not a recognized Bitwarden server", extension/web "update available" nags).
- Bitwarden's release support policy limits server/client compatibility to ±2 major versions
  (https://bitwarden.com/help/bitwarden-software-release-support). `/api/version` should
  return a plausible `YYYY.M.b` value; the server-hosted web vault should be patched to hide
  its upstream version check (Vaultwarden does this) — otherwise the pinned web vault banners
  "new version available" against its own server.

### 2.9 Security stamp / `ForcePasswordReset` handling
- **Affected:** All sessions on password/KDF change.
- Any change to master password, KDF, or 2FA must bump `securityStamp` → all other clients'
  refresh tokens become invalid → they re-prompt for the master password (that's expected
  Bitwarden behavior — KDF change forces re-login everywhere
  (https://community.bitwarden.com/t/low-kdf-iterations-warning-what-should-i-do/62457 )).
  Failing to invalidate refresh tokens leaves ghost sessions; over-invalidating causes
  random re-login storms. Refresh-token endpoint must honor expiry and return
  `invalid_grant` on stamp mismatch (https://github.com/bitwarden/ios/pull/1694).

### 2.10 Premium/license gating
- **Affected:** TOTP codes, Send, etc. in clients.
- Clients show premium features locked unless the server says the user is premium.
  Vaultwarden fakes premium (`premium: true` in profile) rather than licensing; a
  reimplementation that returns paid-account gates inherited from the official server will
  lock basic features that self-hosters expect to work. Decide up-front: return premium true
  (Vaultwarden approach) or implement license tokens.

---

## Category 3 — MINOR / cosmetic

### 3.1 `.well-known` / ToS pages
- Web vault links `/tos` and `/privacy` (served by the web vault bundle itself); API-only
  servers that host the web vault must serve the static bundle incl. these routes. Not a
  login blocker.

### 3.2 Endpoint naming case/pluralism
- Clients call both `/api/accounts/profile` and `/api/accounts/profile-organization` etc.;
  Cozy's reimplementation shows paths that trip implementers (`/api/ciphers/restore` with
  `{ids:[...]}`, 204 responses where the official returns 200)
  (https://docs.cozy.io/en/cozy-stack/bitwarden ).

### 3.3 Icon endpoints and favicon fetch
- `/icons/{domain}/icon.png` used by web vault/browser extension; broken → missing favicons
  only (Vaultwarden 1.37 fixed "check all icon links, not just the first") — cosmetic.

### 3.4 Password-history / cipher `passwordRevisionDate`
- `passwordRevisionDate` must be a valid ISO date; some import paths emit `YYYY-MM-00` day-00
  dates (export artifact above); clients flare on malformed dates — normalize on write.

---

## Version-drift timeline (client breaks that required server fixes)

| When | Client change | Server requirement |
|---|---|---|
| 2022.11 | Two API-service endpoints moved to Identity service | Servers < Bitwarden server 1.46.0 incompatible; Vaultwarden 1.27 | 
(https://bitwarden.com/help/november-deprecation-notice) |
| 2023.1 | WebAuthn/2FA & sync changes | Vaultwarden 1.27.0 required |
(https://vaultwarden.discourse.group/t/unable-to-log-in-with-browser-extension/2223) |
| 2023 | PBKDF2 default raised to 600k (client default since 2023.2.0 server) | Server must store/report 600k for new accounts; legacy 100k honored |
| 2024.12 | SSH-key cipher type + SSH agent | Server must pass through unknown cipher types (VW 1.32.5) |
| 2025.1.3 | (official server) legacy user-encryption-key migration — non-web clients blocked until web-app login | Key migration endpoints must exist for old accounts |
| ~2025 | Browser extension SDK rewrite; `kdfConfig` in prelogin; strict JSON | VW 1.34–1.35 prelogin token fixes; "KDF config is required" era |
| 2025.11+ | `Auth-Email` header on token requests | Servers < 2025 must accept it (clients#17415) |
| 2025.12.1 (Android) | `MasterPasswordHash` in token payload | VW 1.35.2 "Android MasterPasswordHash support" |
| 2026.2.1 | PBKDF2 minimum enforced at 600k client-side; "update encryption settings" prompt | Server must support KDF-change rehash (already required) |
| 2026.4.x | `POST /identity/accounts/prelogin/password` | VW 1.36.0 (new route; fold into existing prelogin) |
| 2026.7.0 | WASM SDK strict cipher deserialization (Login `data` etc.) | VW 1.37.0/1.37.1 required; legacy stored shapes must be normalized at sync |

Pattern: every ~2–4 months Bitwarden auto-ships a client release that breaks some servers.
A reimplementation should (a) never return 404 on unknown identity/account routes used in
login flows, (b) echo stored data through canonical serializers rather than raw, and
(c) treat new-client regressions reported against Vaultwarden as its own spec updates.

## Key reference material found
- Vaultwarden wiki — clients troubleshooting + Android troubleshooting (Flight Recorder tool;
  strictness trend: "new clients are more strict regarding the JSON returned by the server")
- Cozy docs — a second, documented reimplementation of the API (Python):
  https://docs.cozy.io/en/cozy-stack/bitwarden
- Synacktiv forensic walkthrough of the real request/response traffic:
  https://www.synacktiv.com/en/publications/forensic-analysis-of-bitwarden-self-hosted-server
- Bitwarden contributing docs (crypto: master key derivation, HKDF "enc"/"mac" stretching,
  key wrapping): https://contributing.bitwarden.com/architecture/cryptography/crypto-guide