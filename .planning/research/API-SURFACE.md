# Bitwarden Server — Endpoint Inventory (API Surface)

Research doc for reimplementing a Bitwarden-compatible backend (TypeScript · Lambda · DynamoDB).
Clients targeted: Web Vault OSS, iOS, Android, Desktop, Browser extension.

Primary compatibility references (verified against `main` as of 2026-08-17):

| Source | Where | Notes |
|---|---|---|
| **vaultwarden** (Rust) | `src/api/` — full route list extracted, 279 client-facing routes | Best ground truth: it is built *reverse-engineered from* the official server and *validated against real clients* |
| **bitwarden/server** (.NET) | `src/Api/*/Controllers/*.cs`, `src/Identity/IdentityServer/*` | Confirms route sets, client_ids, grant types, attachment file-upload model. No checked-in swagger; it's generated |
| **bitwarden/clients** | `libs/common/src/services/api.service.ts`, `libs/common/src/auth/...`, `libs/common/src/platform/services/file-upload/azure-file-upload.service.ts` | Web vault + browser + desktop call layer |
| **bitwarden/android** | `network/src/main/kotlin/com/bitwarden/network/service/*` | Mobile endpoints are generated from the official server's OpenAPI spec — same surface |

Definitions used below:
- `{api}` = `https://vault.example.com/api`
- `{identity}` = `https://vault.example.com/identity`
- `{icons}` = `https://vault.example.com/icons`
- `{notifications}` = `https://vault.example.com/notifications`
- Auth for all `/api/*` (except noted): `Authorization: Bearer <access_token>` (JWT, opaque to client). `/identity/connect/token` and `/accounts/prelogin*` are unauthenticated.
- All `/api/*` JSON bodies use `camelCase`. All responses are JSON with an `object` discriminator field (e.g. `"object": "cipher"`, `"object": "sync"`).

---

## 1. Identity server — `{identity}/` (10 endpoints, of which 6 are core)

Identity is a stripped-down OAuth2/OIDC "IdentityServer" (Duende) emulation. Form-encoded bodies (`application/x-www-form-urlencoded`), JSON responses. Case-insensitive field names are accepted (vaultwarden parses uncased; official is case-insensitive OAuth2 default).

### 1.1 `POST {identity}/connect/token` — THE login endpoint (grant-type switch)

One form-encoded endpoint, behavior selected by `grant_type`. Request fields common to all grants:
`scope` (always `"api offline_access"`), `client_id`, plus per-grant fields below. Modern clients also send `deviceType`, `deviceIdentifier`, `deviceName`, `devicePushToken` (form fields) for ALL grant types including refresh_token.

| grant_type | Required extra fields | Purpose |
|---|---|---|
| `password` | `username` (email), `password` (master-password **hash**, pre-hashed with the user's KDF — see §3), device fields | Normal login. `authRequest` field = passwordless login (login-with-device, responds to `/api/auth-requests/[id]/response`), in which case `password` holds the 6-digit access code instead of the password hash |
| `refresh_token` | `refresh_token`, `client_id` | Refresh; returns a new token pair (rotation) |
| `client_credentials` | `client_secret` (API key), device fields | Machine login. `client_id` = `"user.<uuid>"` (scope must be `api`) or `"organization.<uuid>"` (scope `api.organization`) |
| `authorization_code` | `code`, `code_verifier` (PKCE, `S256`), device fields | SSO login (→ token before `/connect/authorize` with `code` for OIDC flow) |
| `webauthn` | extension grant, passkey login (mobile); `deviceResponse` (FIDO assertion), `deviceIdentifier` etc. | **Server-only today** — vaultwarden does NOT implement it; needs `/identity/webauthn/assertion-options` + `/api/two-factor/get-webauthn-challenge` counterpart |
| `send_access` | `send_id`, `password_hash_b64` (SHA-256 base64 of send password), client_id | Anonymous Send access token; used by `/api/sends/access`-style downloads |

**Response (200) — the exact shape clients deserialize:**
```jsonc
{
  "access_token": "<jwt>", "expires_in": 3600, "token_type": "Bearer",
  "refresh_token": "<jwt>",
  "Key": "<masterKeyEncryptedUserKey = user.symmetricKey, base64>",   // "" if keyless (2FA key-connector / no password)
  "PrivateKey": "<rsa private key, encrypted, base64 or null>",
  "Kdf": 0, "KdfIterations": 600000, "KdfMemory": 128, "KdfParallelism": 4,   // KdfType enum: 0=PBKDF2_SHA256,1=PBKDF2_SHA512,2=Argon2id
  "ResetMasterPassword": false, "ForcePasswordReset": false,
  "MasterPasswordPolicy": { "Object": "masterPasswordPolicy", "minComplexity": null, ... },
  "AccountKeys": { "publicKeyEncryptionKeyPair": { "wrappedPrivateKey": "...", "publicKey": "...", "signedPublicKey": null, "Object": "publicKeyEncryptionKeyPair" }, "securityState": null, "signatureKeyPair": null, "Object": "privateKeys" },
  "UserDecryptionOptions": { "HasMasterPassword": true, "MasterPasswordUnlock": { "Kdf": {...}, "MasterKeyEncryptedUserKey": "...", "MasterKeyWrappedUserKey": "...", "Salt": "<email>", "Object": "masterPasswordUnlock" }, "Object": "userDecryptionOptions" },
  "TwoFactorToken": "<token>",   // only when 2FA just validated
  "scope": "api offline_access"
}
```
Quirks:
- `expires_in` must be seconds; clients hard-code token lifetime from this value.
- **2FA-required response is HTTP 200 with a JSON body**, NOT an error status (exact shape below). This is the single most delicate part of login compatibility.
- Unauthorized cases: wrong password ⇒ `400` with `{"error":"invalid_grant","error_description":"Username or password is incorrect. Try again."}`; missing refresh_token ⇒ `400 {"error":"invalid_grant"}` (clients specifically match this).
- `client_id` values (verified in `src/Identity/IdentityServer/ApiClient.cs`): `web`, `desktop`, `browser`, `mobile`, `cli`, `connector`. Server doesn't reject unknown ones; clients always send one of these. Each is registered with **specific SSO redirect_uris** (see §3.5) — must be replicated for SSO.
- `deviceType` is the DeviceType enum int (vaultwarden `src/db/models/device.rs`): 0=Android, 1=iOS, 2=Chrome ext, 3=Firefox ext, 4=Opera ext, 5=Edge ext, 6=Windows, 7=macOS, 8=Linux, 9-14=browsers, 15=Amazon, 16=UWP, 17=Safari, 18/19=Vivaldi, 20=Safari ext, 21=SDK, 22=Server, 23-25=CLI, 26=DuckDuckGo.
- Newer clients (≥2025.5) no longer send 2FA via headers; they send `twoFactorToken` / `twoFactorProvider` / `twoFactorRemember` as **form fields** on the second `/connect/token` call. Legacy header variants still honored by vaultwarden: `X-Requested-With: XMLHttpRequest` + `Auth-2FA: <token>` + `Auth-2FA-Remember: 1`, and `Device-*` headers (see §3.3).
- `newDeviceOtp` form field: used with device verification ("Verify new device" email) — ties into `/api/two-factor/get-device-verification-settings` + `POST /api/devices/identifier/{id}/token` OTP flow. (Stretch; vaultwarden supports partially.)
- `send_access` grant response shape: `{"access_token","expires_in":LONG,"token_type":"Bearer","scope":"api.send"}`.

### 1.2 2FA-required response shape (HTTP 200, from `json_err_twofactor`)
```jsonc
{
  "error": "invalid_grant",
  "error_description": "Two factor required.",
  "TwoFactorProviders": ["3", "0"],                    // provider ints as strings
  "TwoFactorProviders2": {
    "0": null,                                         // authenticator: null
    "3": { "Email": "a***@example.com" },              // email 2FA: sends a token; email masked
    "2": { "Nfc": false },                             // YubiKey
    "4": { "Host": "...", "Signature": "..." },        // Duo (legacy iframe) or { "AuthUrl": "..." } (OIDC Duo)
    "5": { "Id": "...", "RPId": "...", "RpName": "..." /*+ challenge data*/ }  // WebAuthn/Passkey
  },
  "MasterPasswordPolicy": { "Object": "masterPasswordPolicy" }
}
```
TwoFactorProviders enum: 0=Authenticator(TOTP), 1=EmailVerificationChallenge(legacy), 2=YubiKey, 3=Email, 4=Duo, 5=WebAuthn, 6=RecoveryCode, 7=OrganizationDuo, 8=ProtectedActions(OTP for destructive ops), 9=EmailVerificationChallengeV2.
Quirk: when email 2FA is the *only* provider, the server may send the email immediately on this response; with ≥2025.5 clients it also exposes `POST /api/two-factor/send-email-login` for a re-send.

### 1.3 Prelogin (KDF discovery) — two paths, both still used
- `POST {identity}/accounts/prelogin` — legacy (older clients), body `{"email":"..."}`
- `POST {identity}/accounts/prelogin/password` — current web/mobile clients (bitwarden/clients `password-prelogin-api.service.ts`); same shape, plus password-history hint? No — same request/response.

Response (200):
```jsonc
{
  "kdf": 0, "kdfIterations": 600000, "kdfMemory": 128, "kdfParallelism": 4,
  "kdfSettings": { "iterations": ..., "kdfType": 0, "memory": ..., "parallelism": ... },
  "salt": null
}
```
Quirk: for unknown email returns **server defaults** (PBKDF2-SHA256, 600k iter on modern servers) — never 404. Clients hash the master password with these params then send the hash in `password` on `/connect/token`. `salt` is always `null` (the email itself is the salt).

### 1.4 Registration
- `POST {identity}/accounts/register` — body: `email`, `masterPasswordHash` **or** the new `masterPasswordAuthentication: {hash, kdf, salt}`, `key` (user symmetric key, base64), `masterPasswordHint`, `keys: {publicKey, privateKey, userAsymmetricKeys?}`, `name`, `organizationUserId` (org invite) / `orgInviteToken`, `acceptEmergencyAccessId` + `acceptEmergencyAccessInviteToken`, `emailVerificationToken` (when signup verification enabled). Returns 200 `{}`.
- `POST {identity}/accounts/register/send-verification-email` — body `{email, name?}`; 204 or returns a JWT token to complete registration in-app (if mail not configured).
- `POST {identity}/accounts/register/finish` — completes registration with the email-verification token.
- (Server-only) `POST {identity}/accounts/register/verification-email-clicked` — conversion tracking; harmless to omit.

### 1.5 SSO endpoints (only needed if SSO is a goal — all `/sso` paths are OPTIONAL for the core task)
- `GET {identity}/sso/prevalidate` → `200` when server has SSO enabled (`{"token":"<jwt>"}`), 404 otherwise. Web vault calls it on the login page to decide whether to show "Enterprise Single Sign-On".
- `GET {identity}/connect/authorize` — first leg of OIDC; queries: `client_id`, `redirect_uri`, `response_type=code`, `scope=api offline_access`, `state` (carries `:sso=<org-identifier>` and `:ln=<client-id>` markers — the `:ln=browser` marker makes the web-vault SSO connector post back to the browser extension), `code_challenge`/`code_challenge_method=S256`. Returns the SSO provider's login page (redirect chain).
- `GET {identity}/connect/oidc-signin?code=&state=` / `?state=&error=&error_description=` — SSO callback landing page, exchanges code → sets browser session, redirects to `redirect_uri` (per-client, see §1.1 client ids). 
- `{identity}/.well-known/openid-configuration` + `{identity}/.well-known/jwks` — OIDC discovery, used by SDK-based auth and SSO. Stretch.
- `POST {identity}/connect/token` with grant `authorization_code` — final SSO token exchange (see §1.1).

### 1.6 Other identity surface
- `POST {identity}/accounts/webauthn/assertion-options` — passkey login challenge (server-only, needed for mobile passkey login; stretch).
- `GET/POST {identity}/connect/endsession` — logout for SSO sessions (Duende default; not verified in clients' normal flows).
- Passwordless device login uses `/api/auth-requests/*` (§2.3) + the `authRequest`/`authRequestAccessCode` field on the `password` grant.

---

## 2. Core API — `{api}/` (~267 endpoints)

All need `Authorization: Bearer <JWT>` unless marked. v1 JSON API (`camelCase`).

### 2.1 `GET {api}/sync` — the sync bundle (most important single response)

Query params: `excludeDomains=true` (web vault), `partial` (mobile initial sync uses `/sync?partial=true` — returns profile+folders+collections only). Response:
```jsonc
{
  "profile": {  // ProfileResponseModel — also returned by GET /api/accounts/profile
    "id": "<uuid>", "name": "...", "email": "...", "emailVerified": true,
    "premium": true, "premiumFromOrganization": false,
    "culture": "en-US", "twoFactorEnabled": bool,
    "key": "<user symmetric key>", "privateKey": "<enc rsa>", "securityStamp": "<uuid>",
    "organizations": [{ "id","name","key","status"(0=invited,1=accepted,2=confirmed),"type"(owner/admin/user...),
       "enabled","usePolicies","useSso"...("use*" capability flags),"billingEmail","object":"organization" }],
    "providers": [], "providerOrganizations": [],
    "forcePasswordReset": false, "avatarColor": "#rrggbb", "usesKeyConnector": false,
    "creationDate": "...", "_status": 1,
    "accountKeys": { "publicKeyEncryptionKeyPair": {...}, "securityState": null, "signatureKeyPair": null, "object": "privateKeys" },
    "object": "profile"
  },
  "folders": [{ "id","name","revisionDate","object":"folder" }],
  "collections": [{ "id","organizationId","name","externalId","hidePasswords","readOnly",
       "manage","assignedCollections":[...] ,"revisionDate","object":"collectionDetails" }],
  "policies": [{ "id","organizationId","type"(PolicyType int),"data":"{}","enabled","object":"policy" }],
  "ciphers": [ /* full cipherDetails list — shape below */ ],
  "domains": { "equivalentDomains": [[ "google.com","google.co.uk" ]], "globalEquivalentDomains": [ { "type": int, "domains": [...], "excluded": bool } ], "object":"domains" } | null,
  "sends": [ { "id","accessId","name","type"(0=text,1=file),"maxAccessCount","accessCount","revisionDate","expirationDate","deletionDate","disabled","passwordProtected","hideEmail","object":"send" } ],
  "userDecryption": { "masterPasswordUnlock": { "kdf": {...}, "masterKeyEncryptedUserKey":"...", "masterKeyWrappedUserKey":"...", "salt":"<email>" } | null },
  "object": "sync"
}
```
Cipher shape (`object:"cipherDetails"`) per item:
```jsonc
{ "object":"cipherDetails","id","type"(1=login,2=secureNote,3=card,4=identity,5=sshKey,6=bankAccount,7=driversLicense,8=passport),
  "creationDate","revisionDate","deletedDate"|null,"reprompt"(0|1),"organizationId"|null,"key"|null,"attachments":[{...}]|null,
  "organizationUseTotp":true,"collectionIds":[...],
  "name","notes","fields":[{name,value,type,linkedId}],"passwordHistory":[...]|null,
  "login":{ "uris":[{"uri","match"}],"username","password","totp","fido2Credentials":[...],"passwordRevisionDate" }|null,
  "secureNote":{...},"card":{...},"identity":{...},"sshKey":{...},"bankAccount":null,"driversLicense":null,"passport":null,
  "edit":true,"viewPassword":true,"favorite":bool, "attachments"...,"folderId"|null,"lastUsedDate","previousPasswords"|null // (2025.12+, else omit)
}
```
Quirks: SSH-key ciphers (type 5) must be **hidden from clients older than 2024.12.0** (they break). `domains` is null when `excludeDomains=true` was sent. `userDecryption.masterPasswordUnlock.salt` must be the user's **email**; kdf casing here is camelCase while the same data in the login response is PascalCase — both casings are expected by different clients (documented in vaultwarden; android `MasterPasswordUnlockDataJson.kt` uses both `masterKeyEncryptedUserKey` and `masterKeyWrappedUserKey`).

### 2.2 Accounts & profile (39 routes including devices + auth-requests)

| Method+Path | Purpose | Request → Response |
|---|---|---|
| `GET /api/accounts/profile` | same profile object as sync | — |
| `PUT/POST /api/accounts/profile` | update `name`, `avatarColor` | → profile |
| `PUT /api/accounts/avatar` | `{avatarColor}` | → `{}` |
| `POST /api/accounts/keys` | legacy: add `{publicKey, privateKey, encryptedMasterKey?}` after key rotation | → keys JSON |
| `POST /api/accounts/password` | change master password (**deletes 2FA + sessions**); body: `masterPasswordHash` (old hash), `newMasterPasswordHash`, `key`, `masterPasswordHint`, `kdf{iterations,memory,parallelism,kdfType}`, `keys: {...}`; verifies old via `SecretVerificationRequest` | → `{}` |
| `POST /api/accounts/set-password` | set password for key-connector users; body `{newMasterPasswordHash?, key, masterPasswordHint, kdfEsta..., keys}` | → `{}` |
| `POST /api/accounts/verify-password` | protected action: `{masterPasswordHash}` → `MasterPasswordPolicy` (or `{otp}` → `{}`) | policy object |
| `POST /api/accounts/kdf` | change KDF: `{kdf{...}, masterPasswordHash}` → `{}` (invalidates security stamp) |
| `POST /api/accounts/security-stamp` | force-logout-all + revoke sessions: `{masterPasswordHash}` | `{}` |
| `POST /api/accounts/email-token` | initiate email change: `{newEmail, masterPasswordHash}` → sends verify email | `{}` |
| `POST /api/accounts/email` | confirm email change: `{token, newEmail}` | `{}` |
| `POST /api/accounts/verify-email` | resend verification | `{}` |
| `POST /api/accounts/verify-email-token` | `{token}` → `{}` |
| `POST /api/accounts/delete-recover` | `{email}` → `{}` (sends delete-link email w/ JWT) |
| `POST /api/accounts/delete-recover-token` | `{token}` → `{}` |
| `POST /api/accounts/delete` / `DELETE /api/accounts` | delete account: `{masterPasswordHash}` (or `[otp]` if 2FA protected actions) | `{}` |
| `GET /api/accounts/revision-date` | account revision date for sync polling | `{revisionDate}` |
| `POST /api/accounts/password-hint` | unauthenticated: `{email}` → `{}` (email hint) |
| `POST /api/accounts/prelogin` | legacy duplicate of identity prelogin (still served on /api) | kdf JSON |
| `POST /api/accounts/api-key` | `{masterPasswordHash}` → `{apiKey, revisionDate}` |
| `POST /api/accounts/rotate-api-key` | same, regenerates key |
| `POST /api/accounts/request-otp` / `POST /api/accounts/verify-otp` | protected-actions OTP (2FA re-verification for destructive ops), `verify-otp: {otp}` → refreshes | |
| `POST /api/accounts/key-management/rotate-user-account-keys` | new `{masterPasswordHash?, otp?, keys{...}}` → `{}` |
| `GET /api/users/{userId}/public-key` | user's RSA public key (sharing) |
| `GET /api/accounts/convert-to-key-connector` ... `POST /api/accounts/set-key-connector-key` | key-connector (enterprise SSO) — stretch |
| `POST /api/accounts/sso/` (nested) | SSO details for export/emergency — stretch |

**Devices**
| `GET /api/devices` | list user's devices |
| `GET /api/devices/identifier/{deviceId}` | device by identifier (client checks if device is new) |
| `POST/PUT /api/devices/identifier/{deviceId}/token` | register push token |
| `POST/PUT /api/devices/identifier/{deviceId}/clear-token` | unregister push |
| `GET /api/devices/knowndevice` | fingerprint/trust check (vaultwarden extension; not on official) |
| `GET /api/tasks` | push queue consumer (vaultwarden-internal, secret path) — clients never call it |

**Auth requests (login-with-device / passwordless):**
| `POST /api/auth-requests` | `{email, type:"AuthenticateAndUnlock", deviceIdentifier, publicKey, requestAccessCode}` → `{id, publicKey, requestApproved}` |
| `GET /api/auth-requests/{id}` | poll status |
| `PUT /api/auth-requests/{id}` | approve/deny from authorized device: `{masterPasswordHash, keys {...}, requestApproved}` |
| `GET /api/auth-requests/{id}/response` | unauth, `?code=<accessCode>` → `{requestApproved, encryptedPrivateKey?, authTokens?}` — the requesting device calls this to complete login |
| `GET /api/auth-requests` / `GET /api/auth-requests/pending` | list pending for email |

### 2.3 Ciphers (58 routes) — the vault CRUD surface

Core (needed by every client):
- `GET /api/ciphers` (list), `GET /api/ciphers/{id}`, `GET /api/ciphers/{id}/details`, `GET /api/ciphers/{id}/admin` (org-admin view)
- `POST /api/ciphers`, `POST /api/ciphers/create` (both create), `POST /api/ciphers/admin` (org admin create)
- `PUT|POST /api/ciphers/{id}` update; `PUT|POST /api/ciphers/{id}/admin` (org admin / bypass collection restrictions)
- `PUT|POST /api/ciphers/{id}/partial` — partial update used by browser extension autofill (login-only fields)
- `PUT|POST /api/ciphers/{id}/collections` and `.../collections_v2` (reorder/manage cipher ⇄ collection membership; v2 accepts bulk `{collectionIds}`); `.../collections-admin`
- `PUT|POST /api/ciphers/{id}/share` + `PUT|POST /api/ciphers/{id}/collections-admin` — personal→org share flow
- Soft delete: `DELETE /api/ciphers/{id}`, `POST /api/ciphers/{id}/delete`, `PUT /api/ciphers/{id}/delete`, and `-admin` variants; bulk: `DELETE|POST|PUT /api/ciphers/{id}`; bulk variants `DELETE/POST/PUT /api/ciphers` (with `ids[]` form/body), `/api/ciphers/admin`, `/api/ciphers/delete-admin`...
- Restore: `PUT /api/ciphers/{id}/restore` (+`Admin`), `PUT /api/ciphers/restore`, `/restore-admin` (body `{ids: []}`)
- Archive: `PUT /api/ciphers/{id}/archive`, `PUT /api/ciphers/archive` (bulk `{ids}`), `{id}/unarchive`, `unarchive` (bulk)
- Move: `PUT|POST /api/ciphers/move` `{folderId, ids: []}`
- Purge trash: `POST /api/ciphers/purge` (+ `?organizationId=` variant), body `{ids: []}`
- `GET /api/ciphers/organization-details?organizationId=...` — org cipher detail list (org vault view)
- `POST /api/ciphers/bulk-collections` — bulk assign
- `POST /api/ciphers/import` (personal), `POST /api/ciphers/import-organization?organizationId=` — import: `{folders:[], ciphers:[], folderRelationships:[[folderIdx,cipherIdx]]}`
- Trash: no separate endpoint — uses `deletedDate` + `/purge`

**Attachments** (see §2.8 for full flow):
- `POST /api/ciphers/{id}/attachment/v2` → `AttachmentUploadDataResponse`: `{object:"attachment-fileUpload", attachmentId, url, fileUploadType: 0|1, cipherResponse|cipherMiniResponse}`
- `GET /api/ciphers/{id}/attachment/{attachmentId}/renew` — fresh upload URL (Azure renew)
- `POST /api/ciphers/{id}/attachment/{attachmentId}` — multipart PUT of bytes for pre-registered attachment (Direct/V2 path)
- `POST /api/ciphers/{id}/attachment` (multipart legacy, single call: data + key), `POST /api/ciphers/{id}/attachment-admin` (org admin legacy)
- `GET /api/ciphers/{id}/attachment/{attachmentId}` — download (streams blob; used by web), and `.../attachment/{id}/admin` (org admin)
- `GET /api/ciphers/attachment/download?attachmentIds=...` — bulk download (server-only; vaultwarden lacks it — stretch)
- `POST /api/ciphers/{id}/attachment/{attachmentId}/share` / `.../share` (legacy azure share) — stretch
- `DELETE /api/ciphers/{id}/attachment/{attachmentId}`, `POST .../delete`, `DELETE .../admin`, `POST .../delete-admin` — delete variants
- `POST /api/ciphers/attachment/validate/azure` — azure validation callback (cloud-only, skip)

Request bodies for create/update: `{type, folderId, organizationId, name, notes, favorite, reprompt, keys: {userKey, encryptedKey?}, login:{uris:[{uri,match}],username,password,totp,passwordRevisionDate}, card:{...}, identity:{...}, secureNote:{type}, sshKey:{privateKey,publicKey,keyFingerprint}, fields:[{name,value,type,linkedId}], passwordHistory, collectionIds[], attachements none}`. Response: cipher object (`object:"cipher"` or `"cipherDetails"`).

### 2.4 Folders (7)
`GET /api/folders`, `GET /api/folders/{id}`, `POST /api/folders` `{name}`, `POST|PUT /api/folders/{id}`, `POST /api/folders/{id}/delete`, `DELETE /api/folders/{id}` → folder objects `{id,name,revisionDate,object:"folder"}`.

### 2.5 Organizations, collections, groups, policies (77) — org support

Organizations:
- `POST /api/organizations` `{name, billingEmail, keys:{publicKey, privateKey}, key, collectionName}` → org
- `GET /api/organizations/{id}` (details), `PUT/POST /api/organizations/{id}`, `POST /api/organizations/{id}/delete`, `DELETE /api/organizations/{id}`, `POST /api/organizations/{id}/leave`
- `POST /api/organizations/{id}/keys` — set org keys (create/key rotation)
- `GET /api/organizations/{id}/public-key`, `GET /api/organizations/{id}/keys`
- `GET /api/organizations/{id}/auto-enroll-status` — SSO auto-enroll
- `POST /api/organizations/domain/sso/verified` — `{email}` SSO domain check (used by web vault login SSO button)
- `GET /api/organizations/{id}/export` — org vault export (csv/json)
- `POST /api/organizations/{id}/api-key` / `/rotate-api-key` — org API key
- `POST /api/public/organization/import` — unscoped public API (org import by key) — stretch
- Billing stubs (web vault tolerates errors): `GET /api/plans`, `GET /api/organizations/{id}/billing/metadata`, `/billing/vnext/*` — return minimal/empty; premium is driven by profile `premium: true`

Org users:
- `POST /api/organizations/{id}/users/invite` `{emails:[]}`, `POST /api/organizations/{id}/users/reinvite`, `POST .../users/{memberId}/reinvite`
- `POST .../users/{memberId}/accept` `{token, organizationUserId?, name?}` (accept → automatically confirms)
- `POST /api/organizations/{id}/users/confirm` (bulk) + `/users/{memberId}/confirm` — `{key}`
- `GET .../users` (+`?search=`), `GET .../users/mini-details`, `GET .../users/{memberId}`, `PUT/POST .../users/{memberId}` (edit type/collections)
- `DELETE .../users/{memberId}`, `DELETE .../users` (bulk `{userIds}`), `POST .../users/{memberId}/delete`
- `PUT .../users/{memberId}/revoke` + bulk `/users/revoke`; `PUT .../users/{memberId}/restore` (+`/restore/vnext`), bulk `/users/restore`
- `POST /api/organizations/{id}/users/public-keys` — `{userIds:[], organizationId}` for bulk share
- Reset password (SSO/reset-password policy): `PUT .../users/{memberId}/reset-password` `{newMasterPasswordHash, key}`, `GET .../users/{memberId}/reset-password-details` (admin-entitled), `PUT .../users/{memberId}/reset-password-enrollment`, `PUT .../users/{memberId}/recover-account` (recovery code) — stretch
- `GET /api/organizations/{id}/users/{memberId}/groups` (group membership)

Collections:
- `GET /api/collections` (all user collections), `GET /api/organizations/{id}/collections`, `.../collections/details`, `.../collections/{colId}/details`
- `POST /api/organizations/{id}/collections` `{name, externalId?, groups?, users?: [{id, readOnly, hidePasswords}]}`
- `PUT|POST .../collections/{colId}`, `DELETE .../collections/{colId}` + `POST .../collections/{colId}/delete`, `DELETE .../collections` (bulk `{ids}`)
- `GET .../collections/{colId}/users`, `POST .../collections/bulk-access` — bulk access control

Groups (admin console): `GET .../groups`, `GET .../groups/details`, `POST .../groups`, `PUT|POST .../groups/{groupId}`, `DELETE .../groups/{groupId}`, `POST .../groups/{groupId}/delete`, `DELETE .../groups` (bulk), `GET .../groups/{groupId}`, `/groups/{id}/details`, `GET/PUT .../groups/{id}/users`, `POST .../groups/{id}/delete-user/{memberId}`

Policies:
- `GET /api/organizations/{id}/policies`, `GET .../policies/token?token=` (verify via invite token)
- `GET .../policies/{polType}` (0=TwoFactorAuthenticationRequired... 4=MasterPassword, 8=ResetPassword, etc.), stub `GET .../policies/master-password`
- `PUT .../policies/{polType}` `{enabled, data}`, new `PUT .../policies/{polType}/vnext` — stretch
- PolicyType enum (subset): 0=TwoFactorRequired,1=MasterPassword,2=PersonalOwnership,3=DisablePersonalVaultExport,4=SingleOrg,5=RequireSso,6=MaxObjectSize,7=Send,8=ResetPassword,9=MasterPasswordStrength,10=PasswordGenerator,11=ActivateAutofill

### 2.6 Sends (14)
- `GET /api/sends` (list), `GET /api/sends/{id}`, `POST /api/sends` (text: `{type:0, name, text:{text, hidden}, maxAccessCount?, expirationDate?, deletionDate?, password?, disabled?, key}`), `PUT /api/sends/{id}`, `DELETE /api/sends/{id}`, `PUT /api/sends/{id}/remove-password`
- File sends: `POST /api/sends/file` (multipart legacy), `POST /api/sends/file/v2` → `{fileUploadType: 0|1, object:"send-fileUpload", url, sendResponse}`, `POST /api/sends/{id}/file/{fileId}` (multipart), `POST /api/sends/{id}/access/file/{fileId}`
- Access/anonymous download: `POST /api/sends/access` (restricted token), `POST /api/sends/access/{accessId}` `{password?}`, `POST /api/sends/access/file/{fileId}`, `GET /api/sends/{id}/{fileId}?t=` (anonymous file download w/ send token)
- Send deletion is by `deletionDate` (client sees `disabled`/`deletionDate`)

### 2.7 Emergency access (18)
- `GET /api/emergency-access/trusted`, `GET /api/emergency-access/granted`, `GET /api/emergency-access/{id}` (details), `PUT|POST /api/emergency-access/{id}` (edit), `DELETE /api/emergency-access/{id}` + `POST /{id}/delete`
- `POST /api/emergency-access/invite` `{email, type(0=Viewer,1=Manager), waitTimeDays}` → `{}`; `POST /{id}/reinvite`
- `POST /api/emergency-access/{id}/accept` `{token, name?, encryptedPrivateKey?, publicKey?}`; `POST /{id}/confirm` `{key}`
- Access flow (grantor → grantee): `POST /{id}/initiate`, `POST /{id}/approve`, `POST /{id}/reject`
- During access: `POST /{id}/view` (returns vault data w/ encrypted keys), `POST /{id}/takeover` (→ new account keys+password reset), `POST /{id}/password` `{newMasterPasswordHash, key}`
- `GET /api/emergency-access/{id}/policies` — org policies before takeover

### 2.8 Attachments — full protocol (Direct AND Azure paths)

Clients (all four) use the **v2** flow by default (`uploadPrepared` in bitwarden/clients):

1. `POST {api}/ciphers/{cipherId}/attachment/v2` with `{key, fileName, fileSize, adminRequest?: bool, lastKnownRevisionDate?}`.
2. Response: `{ object:"attachment-fileUpload", attachmentId, url, fileUploadType: 0|1, cipherResponse (or cipherMiniResponse when adminRequest) }`. `fileUploadType: 0 = Direct`, `1 = Azure`.
3. **Direct (0)** — implementation used by vaultwarden, and by official Bitwarden when `FileUploadType == Direct` (self-host default is Azure; vaultwarden always answers Direct):
   `PUT`-style upload: client POSTs `multipart/form-data` with fields `key` + `data` (the file bytes) to `{api}/ciphers/{id}/attachment/{attachmentId}` (the `url` returned, which is a server-relative path). Response contains the updated cipher. Bulk/Azure not involved.
4. **Azure (1)** — official cloud flow, `url` is an **Azure Blob SAS URL**; must be replicable (S3 with presigned URLs is the natural Lambda/DynamoDB equivalent; vaultwarden's Direct mode is the compatible shortcut):
   - Client PUTs the **encrypted** file bytes to `url` with headers:
     ```
     x-ms-date: <UTC date>
     x-ms-version: <value from SAS query param "sv">
     x-ms-blob-type: BlockBlob
     Content-Length: <byteLength>
     ```
     Expects HTTP **201** on success.
   - Files > 256 MiB: two-step "block blob" PUT → `url?comp=block&blockid=<base64 block id>` (201), then `url?comp=blocklist` with XML `<BlockList><Uncommitted>...</Uncommitted></BlockList>` (201). Block URLs also come from the SAS `sv` param. (bitwarden/clients `azure-file-upload.service.ts`.)
   - SAS URLs can expire mid-upload: client calls `GET {api}/ciphers/{id}/attachment/{attachmentId}/renew` for a fresh `url` and restarts the block.
   - Cancel = `DELETE {api}/ciphers/{id}/attachment/{attachmentId}` ("rollback").
5. Legacy direct (still used by old clients/large web downloads): single multipart `POST {api}/ciphers/{id}/attachment` with `key` + `data` in one call to a `{url}` returned by `POST {api}/ciphers/{id}/attachment` create-call; body fields `key`, `fileName`, `fileSize`, `fileLength`? (server derives). Also `attachment-admin` variant for org-admin edits.
6. Downloads: `GET {api}/ciphers/{id}/attachment/{attachmentId}` streams raw bytes back (vaultwarden path) — plus `?attachmentId=` bulk `GET {api}/ciphers/attachment/download` on cloud (stretch).

Quirks:
- Attachment ids/sizes come from the `attachments` array inside cipher JSON during sync (`AttachmentResponseModel`: `{id, url, fileName, key, size, sizeName}` — `url` is populated client-side from server domain; server returns it in v2? On vaultwarden `to_json` includes `"url": "{host}/api/ciphers/{id}/attachment/{aid}"`).
- Encrypted file name: server stores `fileName` only; `sizeName` is the formatted size.
- Max file size 500 MiB (client-internal limit: 500 MiB uploads refuse; per-file limit constants `MAX_SINGLE_BLOB_UPLOAD_SIZE = 256 MiB`, total files 500 MiB).

### 2.9 Two-factor (26)
- `GET /api/two-factor` — user's 2FA config
- `POST /api/two-factor/get-authenticator` → `{enabled, key}`, `POST /api/two-factor/authenticator` `{masterPasswordHash, key, token}` (enable), `PUT /api/two-factor/authenticator`, `DELETE /api/two-factor/authenticator`
- Email: `POST /api/two-factor/get-email` → `{enabled, email}`, `POST /api/two-factor/send-email` `{email}` (setup code), `POST /api/two-factor/send-email-login` (login re-send, unauth-ish), `PUT /api/two-factor/email` `{masterPasswordHash, email, token}`
- Duo: `POST /api/two-factor/get-duo`, `POST|PUT /api/two-factor/duo {masterPasswordHash, integrationKey, secretKey, host}`
- YubiKey: `POST /api/two-factor/get-yubikey`, `POST|PUT /api/two-factor/yubikey {masterPasswordHash, key1..n}` — USB/NFC Yubikey login needs live validation callback (stretch)
- WebAuthn (hardware keys / passkey-2FA): `POST /api/two-factor/get-webauthn` → `{enabled, keys:[...]}`, `POST /api/two-factor/get-webauthn-challenge` `{masterPasswordHash, deviceResponse?}` → challenge, `POST /api/two-factor/webauthn` `{masterPasswordHash, deviceResponse}` (register), `PUT /api/two-factor/webauthn` (update), `DELETE /api/two-factor/webauthn` — the login-side challenge is served from the connect/token 2FA response (`TwoFactorProviders2["5"]`) and the token exchanged via `twoFactorToken` fields
- `POST /api/two-factor/get-recover` — recovery code display: `{masterPasswordHash}` → `[{code}]`
- `POST|PUT /api/two-factor/disable` `{masterPasswordHash, type}` (disable single provider)
- `GET /api/two-factor/get-device-verification-settings` — new-device-verification (email OTP on unknown device login; pairs with `newDeviceOtp` in token request) — stretch
- `GET /api/webauthn` — vaultwarden extension of old attestation options (official uses the two-factor/get-webauthn-challenge path now)

### 2.10 Events (4-5)
- `GET /api/organizations/{orgId}/events?start=&end=&take=` (pageable), `GET /api/organizations/{orgId}/users/{memberId}/events`, `GET /api/ciphers/{id}/events` (premium), `POST /api/collect` (client event telemetry, fire-and-forget) — optional, web vault org "Events" tab needs the GET ones.

### 2.11 Misc / config / meta
- `GET /api/settings/domains` — equivalent domains (web vault helps "Equivalent domains"); `POST/PUT /api/settings/domains` (user override)
- `GET /api/hibp/breach?username=` — HIBP check for "Reports → Exposed passwords" (vaultwarden proxies external API; stretch)
- `GET /api/alive` → `{}` (health; web vault + mobile probe)
- `GET /api/now` → `{now}` ISO date (used by some clients for clock skew)
- `GET /api/version` → `"2026.6.0"` plain text (mobile checks)
- `GET /api/config` — see §4
- `POST /api/public/organization/import` — public API (no auth, key-based) — stretch

---

## 3. Auth flow details (how the wire protocol actually works)

### 3.1 Login sequence (all clients)
1. `POST {identity}/accounts/prelogin/password` `{email}` → kdf params (or prelogin fallback).
2. Client KeyDerivation:
   - PBKDF2(kdfType 0/1): `hash = PBKDF2-SHA256|SHA512(password, salt=email.toLowerCase(), iterations)` → `MasterKey`.
   - Argon2id (kdfType 2): same salt/params → 32-byte MasterKey.
3. `password` field on `connect/token` = **base64(PBKDF2(MasterKey, salt=email, iterations))** — i.e., a *double* PBKDF2: master key derived from password, then the "password hash" derived from the master key (for PBKDF2 only; Argon2 uses Argon2id(MasterKey, salt, params)).
4. `POST {identity}/connect/token` `grant_type=password`, `username=<email>`, `password=<hash-b64>`, `scope=api offline_access`, `client_id=web|desktop|browser|mobile|cli`, `deviceType=<int>`, `deviceIdentifier=<uuid>`, `deviceName=<name>`, (`devicePushToken` for mobile; `authRequest=<code>` for passwordless).
5. On 2FA-required response (200, see §1.2) → client picks provider (TOTP → code; email → emailed code; webauthn → challenge) and re-posts token with `twoFactorToken=<2FA-TokenFromResponse>`, `twoFactorProvider=<int>`, `twoFactorRemember=0|1`. (Legacy: same call sends `X-Requested-With: XMLHttpRequest`, `Auth-2FA`, `Auth-2FA-Remember` headers.)
6. On success → stores `access_token`, `refresh_token`, `Key` (user's symmetric key), `PrivateKey`... then:
   - `GET {api}/sync?excludeDomains=true` loads everything.
   - Mobile additionally calls `GET {api}/accounts/revision-date` and schedules polling; web calls `GET {api}/config` and `/alive`.

### 3.2 Refresh flow
`POST {identity}/connect/token` `grant_type=refresh_token`, `refresh_token=<jwt>`, `client_id=<same>`. Response: full new token pair (+ same IdentityResponse fields; clients re-read `Key`/`PrivateKey`/Kdf). 400 `{"error":"invalid_grant"}` → clients force logout ("session expired").

### 3.3 API request identity headers (vaultwarden `src/auth.rs`)
- `Authorization: Bearer <JWT>` — decoded, `sub`=user UUID, `device`=device UUID, `sstamp`=security stamp, exp/nbf.
- `device-type: <int>` header — read by server for event logging (clients send it).
- `ClientIp` from `X-Forwarded-For`/`X-Real-IP` (behind proxy).
- New-device/premium checks use `premium: true` (self-host ALWAYS true — vaultwarden hardcodes; official returns true for premium users or premiumFromOrganization).
- Legacy 2FA headers (`X-Requested-With`, `Auth-2FA`, `Auth-2FA-Remember`, `Device-Identifier`, `Device-Name`, `Device-Type`, `Device-Push-Token`) — accepted by vaultwarden for backwards compat; modern clients use form fields.

### 3.4 SSO flow (web vault)
1. User clicks SSO → `POST {api}/organizations/domain/sso/verified` `{email}` → 200 if org domain verified (else 404 → web shows "no SSO").
2. Web vault navigates to `{identity}/connect/authorize?client_id=<web|browser>&redirect_uri={vault}/sso-connector.html&response_type=code&scope=api%20offline_access&state=<base64 {"sso":"<orgid>","ln":"web"}>&code_challenge=...` — for browser extension the `state` marker `:ln=browser` tells the connector to return to the extension.
3. SSO provider authenticates; callback hits `{identity}/connect/oidc-signin?code=...&state=...`; server redirects to `redirect_uri` (the per-client registered URIs from `ApiClient.cs` — web/browser: `{vault}/sso-connector.html`; desktop: `bitwarden://sso-callback` + `http://localhost:8065..8070`; mobile: `bitwarden://sso-callback`; cli: localhost ports; connector: + `bwdc://sso-callback`).
4. Client POSTs `grant_type=authorization_code` + `code` + `code_verifier` → full token response (includes org reset-password info: `ResetMasterPassword: true`, `KeyConnectorEnabled`, etc.).

### 3.5 Passwordless (login with another device)
1. Logging-in device: `POST /api/auth-requests` with its pubkey + access code → poll `GET /api/auth-requests/{id}`.
2. Authorized device (approve) → `PUT /api/auth-requests/{id}` with its keys.
3. Requesting device: `GET /api/auth-requests/{id}/response?code=` → gets `requestApproved + encryptedPrivateKey/encryptedUserKey` → calls `connect/token` with `grant_type=password&username&authRequest=<id>&password=<access code>` (server verifies the access code against the auth request instead of the password) — push notifications to the approving device ride on the notifications websocket/push (see §2.11/§4 notes).

---

## 4. Web Vault specifics (what the browser app needs beyond REST)

- `GET /api/config` — **critical**. Shape (vaultwarden, mirrors official):
  ```jsonc
  { "version": "2026.6.0", "gitHash": "...", "server": { "name": "Vaultwarden", "url": "..." },
    "settings": { "disableUserRegistration": false, "suppressOnboardingInterstitials": false },
    "environment": { "vault": "{domain}", "api": "{domain}/api", "identity": "{domain}/identity",
                     "notifications": "{domain}/notifications", "sso": "", "cloudRegion": null, "icons": "{domain}/icons" },
    "push": { "pushTechnology": 0, "vapidPublicKey": null },
    "featureStates": { "pm-19148-innovation-archive": true, ... }, "communication": null, "object": "config" }
  ```
  - `version` gates client feature behavior (e.g. ≥ 2024.2.0 → individual cipher keys; ≥2025.8 mobile MasterPasswordUnlock). Clients compare **server-reported version** — must be recent-ish even if backend is custom.
  - `featureStates` map: keys are FeatureFlag enums; unknown flags are ignored; absence toggles beta/experimental UI off.
  - `environment` drives which URLs the web vault calls: a wrong `identity`/`api` key here breaks everything.
  - `push.pushTechnology: 0` = no push; mobile reads it from config to decide push strategy.
- Static vault hosting: `GET /` (index.html), `/app-id.json` (FIDO U2F facet → web app id for hardware security keys; content-type `application/fido.trusted-apps+json`), `/.well-known/apple-app-site-association` (iOS passkey autofill), `/{p..}` static assets. Web vault OSS is checked out into the server's webroot — the classic "self-host web vault" deployment serves it from the same origin; must integrate via Lambda static asset handler or separate bucket + same domain.
- `GET /alive` — web vault health probe at boot (needs 200).
- Icons: `GET {icons}/{host}/icon.png` — used in vault rows (site favicon). Host may include subdomain+path; server normalizes and returns an image or fallback. If missing, rows render placeholder — cosmetic but chatty.
- `GET /api/accounts/premium` / subscription/license pages — web "Settings → Premium" page calls `/accounts/subscription` (billing) and `/accounts/premium`; **self-hosted: no-op/error is acceptable** — the UI degrades (vaultwarden simply has no billing routes and web vault works). But `profile.premium: true` is mandatory for web to unlock premium features UI (TOTP codes, sends, etc.).
- Emergency Access UI (Settings → Emergency Access) uses §2.7 endpoints — needed if the feature should be usable from web; missing endpoints → empty lists + disabled buttons, non-fatal.
- `GET /api/hibp/breach` — "Reports → Exposed Passwords" — optional, errors tolerated.
- Two-factor setup UI uses §2.9 — must work for authenticator+email+webauthn to avoid angry users; Duo/YubiKey setup forms exist but are extra.
- Organizations admin console uses §2.5 (groups/policies/collections/users) — org invite/accept must work (it's on by default in web).
- SSO "Enterprise login" button → §3.4 (only if SSO implemented).
- `POST /api/collect` — telemetry; ignore/204.
- `GET /api/accounts/revision-date` — used by web vault's sync timer.
- Vault filter/मetadata: all client-side from sync. Web vault hits NO other endpoints on boot: config → alive → (login) → sync. That's the required boot sequence.

---

## 5. Honesty note — REQUIRED vs optional/stretch for "all 4 clients: login + vault CRUD + orgs + attachments"

### REQUIRED (login + vault CRUD + attachments + basic orgs on all clients)
1. `POST /identity/connect/token` — password + refresh_token grants (+ all response fields incl. 2FA 200-response)
2. `POST /identity/accounts/prelogin` + `/accounts/prelogin/password`
3. `GET /api/sync` (+ full profile/cipher/folder/collection shapes, camelCase, `object` fields)
4. `GET /api/accounts/profile` … actually folded into sync; keep as separate (web calls it)
5. `GET /api/config` (web vault boot), `GET /api/alive`, `GET /api/version`, `GET /api/now`
6. Ciphers: `POST /api/ciphers` · `PUT|POST /api/ciphers/{id}` · `DELETE/POST/PUT /api/ciphers/{id}`(+`/delete`) · `POST /api/ciphers/purge` · `POST /api/ciphers/import` · `PUT|POST /api/ciphers/move` · share → `PUT /api/ciphers/{id}/share` … buIt: minimal set is create/update/delete/trash/restore/archive/move/import
7. Attachments: `POST /api/ciphers/{id}/attachment/v2` + `POST /api/ciphers/{id}/attachment/{id}` + `GET .../{id}` + deletes (Direct mode); Azure mode optional but recommended for >256 MiB & progress
8. Folders: `/api/folders` full CRUD
9. Sends: `/api/sends` list/create + access flow (text; file via v2 or legacy)
10. Two-factor basics: authenticator + email providers on login & setup; recovery codes; `/api/accounts/verify-password` (protected actions for delete/recover flows)
11. Devices: `GET /api/devices` + `identifier/{id}` + token/clear-token (mobile privacy/logout screens)
12. Basic orgs: create, keys, invite/accept/confirm, collections CRUD, org cipher share/collections, leave/delete; `/api/plans` stub
13. Auth requests (#2.3) — mobile "Login with other device" is a headline feature; medium effort
14. `GET /api/accounts/keys`, `POST /api/accounts/password|set-password|kdf|security-stamp|email-token|email|verify-email*`, `/accounts/delete(/-recover)` — account management screens
15. `POST /api/accounts/register` — only if signups enabled
16. `/icons/{host}/icon.png` — favicons (trivial if proxied to Google favicon service like vaultwarden; or drop-in)

Non-critical but trivially cheap and expected: `GET /api/settings/domains`, error catchers returning the Bitwarden JSON error envelope (`{"error":{"code":400,"reason":"Bad Request","description":"..."}}`) — clients parse this envelope for message display; wrong format ⇒ unlocalized/missing error text.

### OPTIONAL / STRETCH (ordered by value)
- Emergency access (§2.7) — web UI + mobile screens; not on the login/vault critical path; moderate effort
- Event log (`GET /api/organizations/{id}/events`, `/api/collect`) — org Events tab; cheap GET, so include
- WebAuthn 2FA + passkey login (`webauthn` grant, `/identity/webauthn/assertion-options`, FIDO2 server) — significant cryptography work; mobile passkeys are their own project
- SSO (OIDC relay: authorize, oidc-signin, authorization_code grant, per-client redirect URIs, SSO config UI) — large
- Azure-style blob upload (`fileUploadType: 1`, SAS URLs, block blobs, renew) — medium; skip if Direct-accepting clients is acceptable (vaultwarden ships Direct-only successfully)
- Duo 2FA (iframe + OIDC modes) ; YubiKey (needs yubico validation API) — niche
- Reset-password policy flows, key-connector, org domain verification, `hibp/breach`, bulk attachment download, `attachment/validate/azure`, billing endpoints, provider (MSP) console, Secrets Manager (separate `/sm` API — entirely out of scope)
- `POST /identity/accounts/register/verification-email-clicked` (marketing tracking)

### Endpoint totals
- Identity: 10 routes (6 core; SSO adds authorize/oidc-signin/prevalidate; passkey + discovery = stretch)
- Core API: accounts+profile 39 · ciphers 58 · folders 7 · org/collections/groups/policies 77 · sends 14 · emergency 18 · 2FA 26 · events 4 · misc (config/alive/now/version/domains/hibp) 9 · public import 1
- Icons 2 (same route, internal/external variants) · Notifications 2 (hub, anonymous-hub) · Web/static 12
- **Total: ~279 routes; required minimum for the stated goal ≈ 60-70, with the "make-all-clients-happy" set ≈ 150**

### Could NOT verify (flagged)
1. `/identity/.well-known/openid-configuration` + `/jwks` — assumed OIDC-standard (Duende); not in vaultwarden; not traced in clients' boot path (SDK flows use it)
2. `POST /identity/connect/token` `webauthn` grant request/response exact field names (`deviceResponse` asserted from Android `webauthn-login-token.request.ts` but response not traced end-to-end)
3. `GET /api/ciphers/attachment/download` query param name (`attachmentIds` assumed from server controller; no client call-site verified)
4. `POST /api/ciphers/attachment/validate/azure` request body
5. `GET /api/organizations/{oid}/billing/vnext/*` response shapes (vaultwarden returns stubs; web tolerates)
6. SignalR `/notifications/hub` wire protocol version details (negotiate vs direct ws, message envelope — clients use a SignalR client; vaultwarden implements custom minimal protocol that works)
7. Exact `TwoFactorProviders2["5"]` (WebAuthn) challenge payload fields for mobile passkey 2FA (server-only path)
8. `POST /api/sends/{id}/file/{fileId}` vs `POST /api/sends/access/file/{fileId}` ambiguity when server sets `fileUploadType:0` alongside v2 (vaultwarden returns `url: /sends/{id}/file/{fileId}` and the client calls `POST /api/sends/{id}/access/file/{fileId}`... actually verified: v2 response `url` + client PUTs via that; flag low-confidence)
9. Emergency-access takeover/initiate exact timing semantics (waitTimeDays / expiry timers — vaultwarden job-driven; server uses background workers)

Sources: github.com/dani-garcia/vaultwarden (`src/api/core/*.rs`, `src/api/identity.rs`, `src/api/notifications.rs`, `src/api/web.rs`, `src/api/icons.rs`, `src/auth.rs`, `src/db/models/{user,cipher,device}.rs`), github.com/bitwarden/server (`src/Api/Auth/Controllers/{AccountsController,TwoFactorController,WebAuthnController,EmergencyAccessController}.cs`, `src/Api/Vault/Controllers/{CiphersController,SyncController,FoldersController}.cs`, `src/Api/Controllers/{ConfigController,DevicesController,InfoController,SettingsController}.cs`, `src/Api/Tools/Controllers/SendsController.cs`, `src/Api/AdminConsole/Controllers/*.cs`, `src/Identity/IdentityServer/{ApiClient,ClientProviders/UserClientProvider,CustomGrantTypes,RequestValidators/WebAuthnGrantValidator}.cs`), github.com/bitwarden/clients (`libs/common/src/services/api.service.ts`, `libs/common/src/auth/models/request/identity-token/*.ts`, `libs/common/src/auth/password-prelogin/*.ts`, `libs/common/src/platform/services/file-upload/{file-upload,azure-file-upload}.service.ts`, `libs/common/src/platform/enums/file-upload-type.enum.ts`), github.com/bitwarden/android (`network/src/main/kotlin/com/bitwarden/network/service/*`).