# FEATURES.md — Synthesized from Research (2026-08-17)

Sources: `.planning/research/API-SURFACE.md`, `CRYPTO.md`, `ARCHITECTURE.md`, `PITFALLS.md`.

## Scale

~279 client-relevant routes; ~60–70 REQUIRED for login + vault + orgs + attachments on all 4 client types. Rest is polish/optional.

## Identity (10 routes) — sine qua non

- `POST /identity/connect/token` — the crown jewel. Grants: password, refresh_token. Client_ids: web, desktop, browser, mobile, other/unknown. 2FA-required is **HTTP 200 with error JSON**, not 401. Errors are `400 invalid_grant` (never 401). Success fields must be byte-perfect: `access_token, expires_in, token_type, refresh_token, Key, PrivateKey, Kdf, KdfIterations, KdfMemory, KdfParallelism, TwoFactorProviders ([]), TwoFactorProviders2 ({}), securityStamp, ...`.
- `POST /identity/accounts/register` — email, masterPasswordHash, masterPasswordHint, key, keys{publicKey, privateKey, encKey}, kdf fields (kdfConfig new shape + legacy).
- `POST /identity/accounts/prelogin/password` (NEW 2026.4+) **and legacy `POST /identity/accounts/prelogin`** — emit BOTH shapes: structured `kdfConfig` (new SDK clients) AND legacy `kdf/kdfIterations` (old clients).
- SSO routes (3) — out of scope (no email/SSO), return compatible errors.
- passkey assertion-options — minimal compatible stub.

## Accounts/Profile/Devices (+39)

- `/api/profile`, `/api/accounts/keys`, `/api/accounts/security-stamp`, `/api/accounts/kdf`, `/api/accounts/password`, `/api/accounts/set-password`, `/api/accounts/delete` (incl. verify-password), `/api/accounts/email` (unverifyable — out), `/api/devices` CRUD + `/api/devices/identifier/{id}/keys`, `/api/accounts/avatar` (stub ok).
- Auth-requests (desktop unlock from mobile) — optional.

## Vault (ciphers 58 + folders 7 + sends 14)

- `GET /api/sync` — full shape: `profile, folders, collections, ciphers, organizations, policies, userDecryption, domainGlobalEquivalentDomains, sends, userServerConfig`.
- Ciphers CRUD + `ids`, `import`, `export` (web vault does client-side export, needs only list), trash `delete`/`restore`, `move`, `share`, `purge`. 6 cipher types (login, note, card, identity, secureNote, sshKey, masterPassword).
- `POST /api/ciphers/{id}/attachment/v2` (fileUploadType **0 = Direct**: client POSTs multipart form data THROUGH the server) + older v1 flow; `POST .../attachment/{id}` legacy. Attachment has own AES-256 key in `key` field; **presigned GET only for download** (5-min, exactly like vaultwarden's S3 backend).
- Folders CRUD. Sends list/create/delete (+file sends reuse multipart).

## Organizations/Collections/Groups/Policies (77)

- Org CRUD, `/api/organizations/{id}/keys`, collections CRUD, groups, users: `invite`, `accept`, `confirm` (RSA org-key wrap, member public key), `reinvite`, roles (`type`: 0 owner 1 admin 2 user 3 manager), org-import, `orgAbility` in sync. Org policies (orgs/policies CRUD + `orgKeys`/`resetPassword` disclaimers).
- Critically: invite flow normally emails a link; **no email** → must surface accept URL/OTP in UI (web vault self-hosted can add a static accept page, or admin dialog shows the token).

## 2FA (26)

- TOTP authenticator setup/disable + recovery codes, and `POST /identity/two-factor` login completion. **Email 2FA impossible (no email)** — omit, clients degrade gracefully (TOTP still works). Duo/Yubikey/Webauthn out.

## Misc (9)

- `GET /api/config` (web vault boot: feature flags/version gates), `/alive`, `/now`, `/api/version`, `/api/domains` (equivalent domains), `/icons/{domain}` (favicon via duckduckgo icon service), `/api/hibp` breach check (optional), `.well-known/`.

## Crypto protocol (server-side reality) — CRITICAL

- **Server does zero real crypto.** It stores/relays EncStrings verbatim and compares auth hashes.
- EncString format: `[type].[iv]|[data]|[mac]` (base64, dots), MAC over iv‖data, type 2 modern default.
- KDF: PBKDF2-SHA256 default 600k iterations, legacy 100k allowed; Argon2id (m=64MB, t=3, p=4); **Argon2id salt = SHA256(email.lower())**, not raw email.
- Login: server receives `masterPasswordHash` in token request; **compare verbatim, never recompute** (legacy clients send PBKDF2(password,email,iters); new SDK send PBKDF2(masterKey, masterPassword, 1)). Constant-time compare.
- Client-side key material the server stores: `key` (masterKeyWrappedUserKey), `keys{publicKey,privateKey}`, per-org `orgKey` wrapped RSA (per membership), collection keys, attachment keys. All relay-only.
- 2026.2.1+ clients enforce 600k minimum iterations; legacy 100k accounts need rehash on kdf change endpoint.

## Architecture (research recommendation — adopted)

- One CloudFront distribution, one origin: default behavior = Web Vault static (S3 + OAC); `/api/*`, `/identity/*`, `/icons/*`, `/alive` → API Gateway HTTP API (single catch-all route) → **single Node 22 Lambda** with hand-rolled ~60-line path router.
- Single DynamoDB table (on-demand), opaque tokens `SESS#{token}` (direct GetItem) + securityStamp snapshot per request; no JWT, no secret management.
- Sync assembled on read from parallel queries (no aggregate item).
- Attachments: client multipart POST through Lambda → S3 (4.5 MB ceiling, Lambda 6 MB limit); download = presigned GET. Only hard functional regression vs vaultwarden.
- No provisioned concurrency; cold starts 300–600 ms acceptable.
- **Argon2id: no Node stdlib — WASM dep (hash-wasm or argon2-wasm) required on Lambda.**
- Web Vault artifact: prebuilt pinned zip (fast, third-party provenance) vs building bitwarden/clients in CI — decision in Phase 1/6.
- Icon fetch = only outbound-network behavior: rate-limit + CloudFront TTL.

## Known client-killers (pitfalls to respect in every plan)

1. Never 404 unknown identity/account login routes (new clients hit prelogin/password, two-factor variants).
2. Emit BOTH kdfConfig and legacy kdf shapes.
3. connect/token byte-perfection incl. TwoFactorProviders2 = {} and 200-with-error for 2FA-required.
4. Strict cipher deserialization: canonical field types; `data` exact types; never fold cipher-level fields.
5. KDF double-hash semantics: store iterations, compare verbatim, rehash on change.
6. Auth-Email header accepted; MasterPasswordHash token field (Android 2025.12.1+).