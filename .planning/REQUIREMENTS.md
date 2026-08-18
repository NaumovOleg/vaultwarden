# REQUIREMENTS.md — Custom Bitwarden-Compatible Server on Lambda

v1 target = all 4 client types usable: Web Vault OSS, mobile (iOS/Android), desktop, browser extension. Backed by PROJECT.md.

## Categories

### AUTH — Identity & session (v1: all)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| AUTH-01 | `POST /identity/accounts/register` — create user (email, masterPasswordHash, key, keys, kdfConfig+legacy kdf params) | salt=email, store what client sends verbatim |
| AUTH-02 | `POST /identity/accounts/prelogin/password` + legacy `/prelogin` — return kdf params for email, both shapes | NEVER 404; unknown email → default 600k PBKDF2 response (no user enumeration) |
| AUTH-03 | `POST /identity/connect/token` password grant for all client_ids (web/desktop/browser/mobile/unknown) — byte-perfect response, opaque access+refresh tokens | errors `400 invalid_grant`; 2FA-required = 200 + error JSON |
| AUTH-04 | refresh_token grant + rotation | revoke old on use |
| AUTH-05 | `POST /identity/two-factor` TOTP+recovery-code completion grant (2FA login) | 200 + success shape |
| AUTH-06 | Logout — revoke token+session | also on all clients |
| AUTH-07 | Security-stamp: checked (cheaply) on every API request; token invalid after stamp change | snapshot in token session |
| AUTH-08 | Device records: register on login (`/api/devices`), list (web vault device manager), delete device | client sends X-Device-* headers |
| AUTH-09 | Constant-time compare of masterPasswordHash; never recompute client hash server-side | PBKDF2(masterKey,masterPassword,1) vs legacy PBKDF2(password,email,iters) — both stored verbatim |
| AUTH-10 | Rate limiting on identity routes (burst + per-email) | DynamoDB TTL token bucket or memoized counter; prevent bruteforce |

### ACCOUNT — profile & key lifecycle (v1: all)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| ACCT-01 | `GET /api/profile` — id, email, name, kdf settings, securityStamp, forcePasswordReset, premium placeholder | clients gate features on premium flags |
| ACCT-02 | `GET /api/accounts/keys` — publicKey, privateKey, encKey (re-registration after key loss — allow if owner of email+hash) | used by browser extension register flow |
| ACCT-03 | `POST /api/accounts/kdf` — Argon2id/PBKDF2 change with client-provided new masterPasswordHash; rehash stored value | 600k min enforced by client; rehash-on-change mandatory (pitfall 5) |
| ACCT-04 | `POST /api/accounts/password` — change password + security-stamp cascade; `set-password` (org reset flow) | revoke other sessions |
| ACCT-05 | `POST /api/accounts/delete` with master-password verification; cascade-delete vault | purge all rows |
| ACCT-06 | Avatar/name preference endpoints — minimal stub acceptable | avatarColor relayed in profile + settable via `PUT/POST /api/accounts/profile` (phase 3); dedicated `PUT /api/accounts/avatar` skipped — web vault renders initials (decision recorded phase 8) |
| ACCT-07 | `/api/accounts/email` — update email + re-KDF on next login (keep simple: store new email; client re-registers keys) | |

### VAULT — sync & ciphers (v1: all)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| VAULT-01 | `GET /api/sync` full shape: profile, folders, collections, ciphers, organizations+orgAbility, policies, userDecryption, sends, domains | canonical serializers; assembled on read from parallel queries |
| VAULT-02 | Cipher CRUD — all 6+ types (login/note/card/identity/secureNote/sshKey/masterPassword), exact field types, strict JSON | pitfall 4: canonical `data`, no folded fields |
| VAULT-03 | Trash: soft-delete, restore, purge; `ids` bulk endpoints | |
| VAULT-04 | Folders CRUD; folder renames propagate in sync (client-side only stores folderId) | |
| VAULT-05 | Import (`POST /api/ciphers/import`), `move` (folder assign bulk), `share` (cipher → collection) | |
| VAULT-06 | Export: client-side (web vault) — needs only sync; mobile export via sync too | no server endpoint needed |
| VAULT-07 | Attachment v2 Direct flow: multipart POST through lambda → S3 object, encrypted-blob storage | 4.5 MB ceiling documented; key field relayed; cleanup on cipher delete |
| VAULT-08 | Attachment download: presigned S3 GET (5 min) — exact vaultwarden-on-S3 flow | bucket private + CORS |
| VAULT-09 | Attachment v1 legacy flow (`/attachment/{id}`) for old clients | db-to-blob via lambda proxy |
| VAULT-10 | `/api/ciphers/{id}/attachment/validate/azure` + v2 azure-style — compatible stub | only if client demands it; research says Direct works for stock clients |

### ORG — organizations & collections (v1: all)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| ORG-01 | Org create (`/api/organizations`) + `keys` endpoint; org RSA-2048 keypair client-generated, orgKey relayed | |
| ORG-02 | Collections CRUD; collection key relay (AES key wrapped by org key) | |
| ORG-03 | Members: invite (token+accept-URL artifact), accept, confirm (org key wrapped with member public RSA), reinvite, remove, roles type 0-3 | **no email**: accept link/OTP surfaced via UI (decision ORG-07) |
| ORG-04 | Org users list / update groups (`/api/organizations/{id}/users`), `orgKeys`/`resetPassword` flow (user ENC private key rewrap via org key) | |
| ORG-05 | Share ciphers to collections; read via sync `collections` + permission model | |
| ORG-06 | Org policies CRUD (master-password policy stubs honored as no-ops is NOT OK — return stored values) | |
| ORG-07 | Invite-accept UX without email: add static accept page (web vault static build + tiny route) showing accept URL in org members UI or via API response | open decision — default: accept-token page on same origin |

### 2FA — v1: TOTP only

| REQ | Requirement | Notes |
|-----|-------------|-------|
| TFA-01 | TOTP authenticator enable/disable (`/api/two-factor/authenticator`) + disable-2FA key exchange blocks | shared key returned once, relayed |
| TFA-02 | Recovery codes (generate/list/use) | one-time, rotate |
| TFA-03 | 2FA login: token error → `TwoFactorProviders`/`TwoFactorProviders2` + 200; completion via `/identity/two-factor`; remember-device token | |
| TFA-04 | Email 2FA: OUT (no email). Duo/Yubikey/Webauthn: OUT (v2). Clients must degrade gracefully | Email 2FA shipped in v1 WITHOUT transport (phase 6): setup/login codes echoed in response + logged; switch to SES only if email ever lands (ponytail). Duo/Yubikey/Webauthn remain OUT (v2). Verify graceful degradation |

### MISC (v1)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| MISC-01 | `GET /api/config` (web vault boot), `/api/version`, `/alive`, `/now` | version gates client features — keep honest values |
| MISC-02 | `/icons/{domain}` favicon service (duckduckgo fetch → CloudFront-cached, rate-limited) | only outbound call |
| MISC-03 | `/api/domains` equivalent domains (static table from bitwarden `global-domain-whitelist`) | web vault URL detection |
| MISC-04 | Sends: list/create (text+file), delete | file sends reuse attachment multipart |
| MISC-05 | Emergency access: trust/accept/access-requests/grant/takeover basic flow | v1 full-ish, no email = token surfacing again |
| MISC-06 | `/api/hibp` — optional stub | shipped phase 7: honest 404 (check unavailable), never a false "no breaches" |

### INFRA (v1)

| REQ | Requirement | Notes |
|-----|-------------|-------|
| INFRA-01 | CloudFront single origin: static S3 default + `/api/*`,`/identity/*`,`/icons/*`,`/alive` → API GW HTTP API → single Node 22 Lambda | same-origin, no CORS |
| INFRA-02 | Single DynamoDB table on-demand: users, sessions (opaque tokens), ciphers, folders, collections, orgs/members, devices, 2FA, sends, attachments meta, invites | |
| INFRA-03 | S3: attachments (private), static web vault, icons cache; bucket CORS for presigned GET | |
| INFRA-04 | CDK v2: replace docker/EFS constructs; two stacks (data + service) | delete docker/, EFS, backup lambda is replaced by DynamoDB PITR note |
| INFRA-05 | Web Vault OSS static artifact pinned; deploy via BucketDeployment | decision: prebuilt zip vs CI build |
| INFRA-06 | Logging (request id, auth events), CloudWatch alarms, budget alert (keep existing CostGuard pattern) | |
| INFRA-07 | Backup/DR: DynamoDB PITR + S3 attachment versioning; restore runbook | replaces nightly SQLite backup |
| INFRA-08 | Tests: unit (routing, serializers) + @bitwarden/sdk-based E2E script against deployed stage (register→login→sync→cipher CRUD→2FA→org) | bash `e2e-auth.sh`+`e2e-vault.sh` are the established integration harness (decision phases 7-8; SDK suite would duplicate them) |
| INFRA-09 | Local dev: single `dev.ts` http-server wrapping handler; DynamoDB target = real AWS dev table (no emulators) | |

## v2 (deferred — explicit, revisited after phase 8)

- Email VERIFICATION (blocked by no-email constraint; email-2FA codes already ship without transport — would need SES later)
- Duo/Yubikey/Webauthn 2FA, passkeys/FIDO2 endpoints (extension uses passkeys increasingly — revisit)
- SSO (SAML/OIDC relay) — incompatible with no-email/no-idp stance
- Groups advanced policies, org password policies ENFORCEMENT (CRUD ships as stored values; no-ops rejected by design)
- Billing/premium nags, family plans
- SignalR push (clients poll — verified acceptable)
- Edge-handled attachment PUT (6 MB ceiling removal via Lambda@Edge 200→201) — escape hatch documented
- Org events (`GET /api/organizations/{id}/events`, `/api/collect`) — cheap GET, org Events tab; not built, no client blocker reported
- Passwordless/passkey endpoint drift, SDK-tier E2E harness (bash e2e scripts are the established harness)

Moved OUT of v2 since requirements were written: email 2FA (shipped v1, no transport), emergency access (shipped v1, phase 8), settings/domains + hibp stub (shipped v1, phase 7).

## Out of scope (reasoning)

- Email delivery in any form (user constraint)
- Admin panel (vaultwarden had 28 routes — reintroduce only if debugging demands)
- Container/runtime infrastructure of any kind (project motivation)