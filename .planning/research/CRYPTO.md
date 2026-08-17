# Bitwarden Client Crypto Protocol — Exact Specification

Research source for the vaultwarden-compatible server reimplementation
(TypeScript / AWS Lambda / DynamoDB). Everything here was extracted from
vaultwarden `main` (2026-08), the Bitwarden clients monorepo, bitwarden/sdk
(v1.0.0 tag), and the Bitwarden Security White Paper.

**Architectural rule:** all real cryptography happens client-side. The server
stores, relays, and compares ciphertext/hashes verbatim. The server's only
crypto tasks are: constant-time string comparison of auth hashes, JWT
signing, and (optionally) re-hashing the submitted auth hash at rest.

---

## 1. EncString — the core serialized ciphertext format

Every encrypted value in Bitwarden JSON is an **EncString**: a single string
`[type].[payload]` where `[type]` is a single digit. String base64 is
**STANDARD with padding** (`+/`, `=`), never base64url.

### 1.1 Symmetric: `[type].[iv]|[data]|[mac]` (pipes inside the payload part)

| Type | Name | Shape | Notes |
|---|---|---|---|
| 0 | `AesCbc256_B64` | `0.<b64(iv)>|<b64(ciphertext)>` | legacy: user key wrapped with plain master key |
| 1 | `AesCbc128_HmacSha256_B64` | `1.iv\|data\|mac` | legacy 128-bit |
| 2 | `AesCbc256_HmacSha256_B64` | `2.iv\|data\|mac` | **default for everything today** |

- `iv` = 16 bytes, AES-256-CBC with PKCS#7, `mac` = 32 bytes.
- **MAC = HMAC-SHA256(mac_key, iv ‖ ciphertext)** — covers IV + data.
  (SDK `crates/bitwarden-crypto/src/aes.rs`)
- A ciphertext with unknown/missing mac is unusable by modern clients.

### 1.2 Asymmetric (RSA-2048, no IV)

| Type | Name | Shape |
|---|---|---|
| 3 | `Rsa2048_OaepSha256_B64` | `3.<b64(ciphertext)>` |
| 4 | `Rsa2048_OaepSha1_B64` | `4.<b64(ciphertext)>` |
| 5 | `Rsa2048_OaepSha256_HmacSha256_B64` | `5.<data>\|<mac>` |
| 6 | `Rsa2048_OaepSha1_HmacSha256_B64` | `6.<data>\|<mac>` |

(SDK `crates/bitwarden-crypto/src/enc_string/asymmetric.rs`.) Types 4/5/6
carry a trailing `|mac`; used for org keys wrapped with member public keys.

### 1.3 EncArrayBuffer (attachment content — binary, not a string)

Byte layout: `[1B type] [16B iv] [32B mac (type 2 only)] [AES-256-CBC data]`.
Type 2 prefix = **49 bytes**; total encrypted payload = 49 + padded size.
(clients `libs/legacy-crypto/src/models/enc-array-buffer.ts`.)
Server stores the raw multipart bytes as-is and serves them back as a stream.

---

## 2. KDF and `/identity/accounts/prelogin`

`KdfType` (clients `libs/legacy-crypto/src/enums/kdf-type.enum.ts`):
`0 = PBKDF2_SHA256`, `1 = Argon2id`.

`POST /identity/accounts/prelogin` `{email}` → always 200:

```json
{ "kdf": 0, "kdfIterations": 600000, "kdfMemory": 64, "kdfParallelism": 4 }
```

- **Unknown user ⇒ return the defaults** (`0 / 600000 / 64 / 4`). Clients
  pre-derive from this before registering; a wrong response breaks both
  registration and the immediately-following login.
  (vaultwarden `accounts.rs` `post_prelogin`: `DEFAULT_ITERATIONS = 600_000`,
  `DEFAULT_MEMORY = 64`, `DEFAULT_PARALLELISM = 4`.)
- `kdf` is a JSON **integer**, never a string.
- `kdfMemory` is in **MiB** (64, not 65536). Argon2lib converts `*1024` to KiB.
- Known user ⇒ stored `client_kdf_type/iter/memory/parallelism`.

---

## 3. Key hierarchy (client-side; server only stores results)

### 3.1 Master key

```
salt = email.trim().toLowerCase()            (UTF-8)
PBKDF2 : MasterKey = PBKDF2-HMAC-SHA256(masterPassword, salt, kdfIterations)   // 32 B
Argon2 : MasterKey = Argon2id(secret=masterPassword,
                              salt = SHA256(email.trim().toLowerCase()),        // NOT raw email!
                              m=64MiB*1024, t=3, p=4, v=0x13, out=32B)
```

- Argon2 salt is the **SHA-256 digest of the lowered email** (SDK
  `keys/utils.rs` `derive_kdf_key`: `Sha256::new().chain_update(salt)`).
- White paper: *"PBKDF2 with a default of 600,000 iteration rounds to stretch
  the master password with a salt of the account email address. The resulting
  salted value is the 256-bit Master Key."*

### 3.2 Master password authentication hash (what the server compares)

```text
current (2025+):  authHash = base64( PBKDF2-HMAC-SHA256(secret=MasterKey, salt=masterPassword, iterations=1) )
```

- White paper: *"A Master Password Hash, generated using PBKDF-SHA256 with a
  payload of the Master Key and with a salt of the master password, is sent
  to the server… by comparing the hash to that which is stored server-side."*
- clients `master-password.service.ts` `masterPasswordAuthenticationHash`:
  `pbkdf2(masterKey.key, masterPassword, 1, "sha256")` → b64.
- SDK `login/password.rs` → `MasterKey.derive_master_key_hash(password,
  HashPurpose::ServerAuthorization = 1)`, i.e. **1 iteration**.

```text
legacy (pre-2025 clients):  authHash = base64( PBKDF2-HMAC-SHA256(masterPassword, email.trim().toLower(), kdfIterations) )
```

- Both generations exist in the wild; the server must accept any submitted
  hash **verbatim-compared** (see §4.3) — never recompute it.

### 3.3 HKDF stretch (master key → enc/mac keys)

```text
stretch(masterKey):
  enc  = HKDF-Expand(PRK=masterKey, info="enc", L=32, SHA-256)
  mac  = HKDF-Expand(PRK=masterKey, info="mac", L=32, SHA-256)
```

- Implemented as a single expand of 64 bytes split in half
  (SDK `keys/utils.rs` `stretch_kdf_key`; legacy JS used separate
  `info="enc"`/`"mac"` calls). **Server never needs this** — it only stores
  the resulting EncString. (Marked: verify against SDK source before testing
  client compat — see §Unverified.)

### 3.4 User key

- 64 random bytes = 32B enc + 32B mac key (\"512-bit\").
- Stored form = encrypted with the **stretched** master key ⇒ **type 2**:
  `2.<iv>|<data>|<mac>`. Legacy accounts: type 0 (unstretched, no mac).
- This string is the `key` in register payload, `Key` in token response,
  `key` in profile.

### 3.5 RSA key pair (user, and per organisation)

- RSA-2048.
- `publicKey` = base64 DER **SPKI** (plaintext).
- `encryptedPrivateKey` = PKCS#8 DER, encrypted with the user key
  (or org key): type 2.
  (SDK `rsa.rs` `make_key_pair`/`rsa_private_key_encrypt`.)

---

## 4. Registration, login, KDF change

### 4.1 `POST /identity/accounts/register`

```jsonc
{
  "email": "user@example.com",
  "name": "User",
  "masterPasswordHash": "<b64>",            // auth hash per §3.2 (any client generation)
  "masterPasswordHint": "hint",
  "key": "2.<iv>|<data>|<mac>",             // user key, wrapped w/ stretched master key
  "keys": {
    "publicKey": "<b64 DER SPKI>",
    "encryptedPrivateKey": "2.<iv>|<data>|<mac>"
  },
  "kdf": 0,                                 // int! 0=PBKDF2, 1=Argon2id
  "kdfIterations": 600000,
  "kdfMemory": 64,                          // MiB
  "kdfParallelism": 4
}
// v2 clients (2025+) may add: "masterPasswordAuthentication", "masterPasswordUnlock"
```

(vaultwarden `RegisterData`: `master_password_hash`, `master_password_hint`,
`email`, `name`, `key`, `keys{public_key, encrypted_private_key}`, `kdf`,
`kdf_iterations`, `kdf_memory`, `kdf_parallelism`,
`master_password_auth`, `master_password_unlock`.)
Response: the token JSON of §4.2 + a rewritten user JSON — clients only use
the token fields.

### 4.2 `POST /identity/connect/token` (login, form-encoded)

```
grant_type=password
client_id=web|browser|desktop|mobile|cli       // "cli" (the CLI refuses non-exact)
username=<email>
password=<authHash>                            // per §3.2 — verbatim compare
scope=api offline_access
device_type=<0-25 int>
device_identifier=<uuid>
device_name=<string>
// optional: twoFactorToken=<token>  twoFactorProvider=<int>  (0=Auth,1=Email,2=Duo,3=YubiKey,5=Remember,6=OrgDuo,7=WebAuthn)
```

(vaultwarden `identity.rs` `LoginData`; SDK password_token_request.rs uses
`deviceType` as u8, `deviceIdentifier`, `deviceName`.)

### 4.3 Server-side verification (critical)

- **Constant-time string comparison** of submitted `password` vs stored
  value. The server MUST NOT re-derive a KDF at login.
- vaultwarden stores, instead of the raw hash, a server-side re-hash:
  `stored = PBKDF2-HMAC-SHA256(secret=clientAuthHash, salt=64 random bytes, iterations=CONFIG.password_iterations)` (default 600k, min 100k) — the
  \"double hash\" from accounts.rs:
  > \"Double hash the master password hash with some random salt.\"
  On login it re-derives `PBKDF2(submitted, storedSalt, storedIterations)`
  and constant-time-compares; if the stored iteration count is below the
  current config it transparently re-hashes and upgrades on the fly.
  (`db/models/user.rs` `set_password`/`check_valid_password`, PRs #4913/#5060.)
- Either storage scheme is invisible to clients. Reimplementation: storing
  the raw hash + `timingSafeEqual` is protocol-equivalent and matches
  upstream Bitwarden.

### 4.4 Token response (JSON)

```jsonc
{
  "access_token": "<JWT>", "expires_in": 3600, "token_type": "Bearer",
  "refresh_token": "<JWT>",
  "Key": "2.<iv>|<data>|<mac>",
  "PrivateKey": "2.<iv>|<data>|<mac>",
  "Kdf": 0, "KdfIterations": 600000, "KdfMemory": 64, "KdfParallelism": 4,
  "ResetMasterPassword": false, "ForcePasswordReset": false,
  "MasterPasswordPolicy": { "Object": "masterPasswordPolicy" },
  "scope": "api offline_access",
  "UserDecryptionOptions": {
    "HasMasterPassword": true, "Object": "userDecryptionOptions",
    "MasterPasswordUnlock": { "Object": "masterPasswordUnlock", /* kdf settings */ }
  },
  "TwoFactorToken": "<opaque>"               // only when 2FA used + remember requested
}
```

Exact key casing from vaultwarden `identity.rs` `authenticated_response`:
`Key`, `PrivateKey`, `Kdf`, `KdfIterations`, `KdfMemory`, `KdfParallelism`.

### 4.5 KDF change — `PUT /accounts/kdf`

```jsonc
{ "kdf": 1, "kdfIterations": 3, "kdfMemory": 64, "kdfParallelism": 4,
  "masterPasswordHash": "<new auth hash>" }      // client re-derived with new KDF
```
then `POST /accounts/keys` with the re-wrapped user key
(`key`, `publicKey`, `encryptedPrivateKey`). Server just persists.

---

## 5. `/api/sync` (GET) — full response shape

vaultwarden `src/api/core/ciphers.rs` `#[get("/sync?<data..>")]`
(`SyncData` = `{excludeDomains}`). Build order and names:

```jsonc
{
  "profile": { … §5.1 },
  "folders": [ §5.3 ],
  "collections": [ §5.4 ],
  "policies": [],
  "ciphers": [ §5.5 ],
  "domains": null | { "equivalentDomains": […], "globalEquivalentDomains": [{ "type": 0, "domains": ["google.com"], "excluded": false }], "object": "domains" },
  "sends": [],
  "userDecryption": {
    "masterPasswordUnlock": {
      "kdf": { "kdfType": 0, "iterations": 600000, "memory": 64, "parallelism": 4 },
      "masterKeyEncryptedUserKey": "<user key EncString>",
      "masterKeyWrappedUserKey": "<same>",      // both names, same value (SDK compat note in code)
      "salt": "<email>"                          // = email, not random
    }
  },
  "object": "sync"
}
```

Note: iterating SSH-key ciphers (`type:5`) is filtered by client version
`>= 2024.12.0`.

### 5.1 profile

```jsonc
{
  "_status": 2,
  "accountKeys": { "publicKeyEncryptionKeyPair": { "wrappedPrivateKey": "2…", "publicKey": "<b64>", "signedPublicKey": null, "object": "publicKeyEncryptionKeyPair" }, "securityState": null, "signatureKeyPair": null, "object": "privateKeys" },
  "id": "<uuid>", "name": "…", "email": "…", "emailVerified": true,
  "premium": true, "premiumFromOrganization": false, "culture": "en-US",
  "twoFactorEnabled": true,
  "key": "<user key EncString>",
  "privateKey": "<encrypted private key>",
  "securityStamp": "<uuid>",
  "organizations": [ §5.2 ],
  "providers": [], "providerOrganizations": [],
  "forcePasswordReset": false, "avatarColor": null,
  "usesKeyConnector": false, "creationDate": "<ISO8601>",
  "object": "profile"
}
```

### 5.2 profileOrganization (per confirmed membership — includes `key`!)

```jsonc
{
  "id": "<org uuid>", "name": "Org", "identifier": null, "seats": 20,
  "maxCollections": null, "usersGetPremium": true, "use2fa": true,
  "useDirectory": false, "useEvents": true, "useGroups": true, "useTotp": true,
  "useScim": false, "usePolicies": true, "useApi": true, "selfHost": true,
  "hasPublicAndPrivateKeys": true, "resetPasswordEnrolled": false,
  "useResetPassword": true, "ssoBound": false, "useSso": false, "useKeyConnector": false,
  "useSecretsManager": false, "usePasswordManager": true, "useCustomPermissions": true,
  "useActivateAutofillPolicy": false, "useAdminSponsoredFamilies": false,
  "useRiskInsights": false, "useDisableSMAdsForUsers": true,
  "useInviteLinks": false, "useMyItems": false, "useOrganizationDomains": false,
  "usePam": false, "usePhishingBlocker": false,
  "organizationUserId": "<membership uuid>",
  "providerId": null, "providerName": null, "providerType": null,
  "familySponsorship*": […nulls], "productTierType": 3,
  "keyConnectorEnabled": false, "keyConnectorUrl": null,
  "accessSecretsManager": false,
  "limitCollectionCreation": false, "limitCollectionDeletion": true,
  "limitItemDeletion": false, "allowAdminAccessToAllCollectionItems": true,
  "userIsManagedByOrganization": false, "userIsClaimedByOrganization": false,
  "permissions": { "accessEventLogs": false, …, "createNewCollections": bool,
    "editAnyCollection": bool, "deleteAnyCollection": bool, "manageGroups": false, … },
  "maxStorageGb": 32767,
  "userId": "<user uuid>",
  "key": "<org key EncString, RSA-wrapped for THIS member>",     // per-membership!
  "status": 2, "type": 2, "enabled": true,
  "object": "profileOrganization"
}
```

`status`: 0=Invited 1=Accepted 2=Confirmed. `type`: 2=Admin 3=Manager 4=User 5=Custom.
(vaultwarden `db/models/organization.rs` `Membership::to_json`.)

### 5.3 folder

```jsonc
{ "id": "<uuid>", "name": "2.<iv>|<data>|<mac>", "revisionDate": "<ISO8601>", "object": "folder" }
```

### 5.4 collection (details variant)

```jsonc
{
  "externalId": null,
  "id": "<uuid>", "organizationId": "<org uuid>",
  "name": "2.<iv>|<data>|<mac>",            // encrypted with ORG key
  "type": 0,
  "defaultUserCollectionEmail": null,
  "object": "collection",
  "readOnly": false, "hidePasswords": false, "manage": false,   // per-user overrides in details variant
  "permissions": { "read": true, "manage": true, "modify": true, "delete": true }
}
```

(vaultwarden `db/models/collection.rs` `to_json` + `to_json_details`.)

### 5.5 cipher — `cipherDetails` (the object clients actually consume)

vaultwarden `db/models/cipher.rs` `to_json`:

```jsonc
{
  "object": "cipherDetails",
  "id": "<uuid>",
  "type": 1,                       // 1 login, 2 secureNote, 3 card, 4 identity, 5 sshKey, 6 bankAccount, 7 driversLicense, 8 passport
  "creationDate": "<ISO8601>",
  "revisionDate": "<ISO8601>",
  "deletedDate": null,
  "reprompt": 0,                   // 0 or 1 (master-password reprompt)
  "organizationId": null,
  "key": null,                     // per-cipher key if present (2025.6+)
  "attachments": null | [{ "id", "url", "fileName": "2…", "size": "123", "sizeName": "120 B", "key": "2…", "object": "attachment" }],
  "organizationUseTotp": true,
  "collectionIds": [],
  "name": "2…", "notes": null, "fields": null | [{ "name": "2…", "value": "2…", "type": 0, "linkedId": null }],
  "passwordHistory": null | [{ "lastUsedDate": "<ISO8601>", "password": "2…" }],
  "login": null | { "username": "2…", "password": "2…", "passwordRevisionDate": null, "uris": null | [{ "uri": "2…", "match": null | 0-5 }], "totp": null | "otpauth://…", "fido2Credentials": null },
  "secureNote": null | { "type": 0 },
  "card": null | { "cardholderName", "brand", "number", "expMonth", "expYear", "code": all "2…" },
  "identity": null | { "title", "firstName", "middleName", "lastName", "address1", "address2", "address3", "city", "state", "postalCode", "country", "company", "email", "phone", "ssn", "username", "passportNumber", "licenseNumber": all "2…" },
  "sshKey": null | { "privateKey": "2…", "publicKey": "2…", "keyFingerprint": "2…" },
  "bankAccount": null | { "accountHolderName", "accountNumber", "routingNumber": "2…", "accountType": null },
  "driversLicense": null | { "number", "state", "dateOfBirth", "sex", "country", "licenseNumber": "2…" },
  "passport": null | { "passportNumber", "expirationDate", "personalNumber", "fullName", "dateOfBirth", "country": "2…" },
  "folderId": null,                // user sync only
  "favorite": false,               // user sync only
  "archivedDate": null,            // user sync only
  "edit": true,                    // false when collection read-only for user
  "viewPassword": true,            // false when hidePasswords
  "permissions": { "delete": true, "restore": true }
}
```

**URIs:** `match` must be int or null (0 domain, 1 host, 2 startsWith, 3 regex,
4 exact, 5 never); string values are coerced (vaultwarden keeps clients from
crashing). `passwordRevisionDate` must be an ISO date or null.
**SSH keys:** `keyFingerprint` must be present even if empty on fetch.
**SecureNote:** `type` must be a number (default 0).

---

## 6. Attachments & org encryption

### 6.1 Attachment upload (multipart)

`POST /api/ciphers/<id>/attachment[/v2]` — multipart/form-data:
- `data`: file bytes = **EncArrayBuffer binary** (§1.3): `[1B type][16B iv][32B mac][ciphertext]`. Server stores the exact byte stream.
- `key`: the 64-byte attachment key encrypted with the **cipher's effective
  key** (per-cipher `key` if present, else the user/org key) — type 2 EncString.
- `fileName`: encrypted with the cipher's effective key.
- The attachment key is a fresh random 64-byte SymmetricCryptoKey generated
  client-side; content is AES-256-CBC-HMAC-SHA256 under it.
(SDK `crates/bitwarden-vault/src/cipher/attachment.rs` + cipher.rs; white
paper \"a separate key is generated for each file\".)
Server must allow partial uploads (`offset`/multipart continuation headers
`Content-Range`) — vaultwarden implements chunked uploads; not required for
minimal fidelity but clients (mobile) use it.

### 6.2 Organisations

- Created by the client: org **RSA-2048 pair** + a random 64-byte **org key**
  (SymmetricCryptoKey); the create-org payload (`POST /organizations`) ships
  `keys{publicKey, encryptedPrivateKey}` and `key` (org key RSA-wrapped to
  the owner), and the first collection name encrypted with the org key.
- Invites: `POST /organizations/…/invite` `{emails, type, accessAll, collections: [{id, readOnly, hidePasswords, manage}]}`.
- Accept+confirm: the member sends their public RSA key; admin confirms with
  `{key: orgKey wrapped with member's public key, …}` — stored as the
  **per-membership** org key and served in `profileOrganization[].key`.
- Before confirmation the sync has no `key` for that membership; clients
  refuse to use org data without it.

---

## 7. Two-factor (minimal)

- Enabled 2FA ⇒ login returns **400** with
  `{"error":"invalid_grant","error_description":"Two factor required.","TwoFactorProviders":["0"],"TwoFactorProviders2":{"0":null},"MasterPasswordPolicy":{"Object":"masterPasswordPolicy"}}`.
- Retry `POST /connect/token` with `twoFactorToken` + `twoFactorProvider`
  (vaultwarden `identity.rs` `twofactor` flow; legacy
  `/identity/two-factor` endpoint is no longer used by clients).
- TOTP = provider `0` (Authenticator). Secret is a normal TOTP base32 secret;
  `TwoFactorProviders2` entries may carry provider-specific data
  (e.g. `{"Email": …}`/`{"Duo": …}` for the settings endpoint
  `GET /api/two-factor`).
- On success with `twoFactorRemember=1`, `TwoFactorToken` in the token
  response lets clients skip 2FA for 30 days.

---

## 8. Server MUST-list (concrete)

1. Store every EncString (`key`, names, notes, fields, uri, ssh/identity/totp,
   collection names, folder names…) **byte-for-byte untouched**.
2. Prelogin: defaults `{0,600000,64,4}` for unknown emails.
3. Login: constant-time compare of submitted hash vs stored; never re-derive
   from a password we don't have (only the hash is ever transmitted).
4. Token response key casing: `Key`, `PrivateKey`, `Kdf`, `KdfIterations`,
   `KdfMemory`, `KdfParallelism`.
5. Sync: `organizations[].key` is per-membership stored value; profile
   `accountKeys.publicKeyEncryptionKeyPair.wrappedPrivateKey` required.
6. `userDecryption.masterPasswordUnlock` includes BOTH
   `masterKeyEncryptedUserKey` and `masterKeyWrappedUserKey` (same value)
   plus `salt` = user email — needed by current clients after login.
7. Cipher `type` values 1..8, all type-data keys nullable, URI `match`
   numeric-or-null, `passwordRevisionDate` ISO-or-null.
8. Attachments: store raw multipart bytes (49-byte EncArrayBuffer prefix for
   type 2); never parse the content.

---

## Sources

- vaultwarden main: `src/api/identity.rs` (login/token), `src/api/core/accounts.rs`
  (prelogin/register/kdf), `src/api/core/ciphers.rs` (`GET /sync`), `src/api/core/mod.rs`
  (sync context), `src/db/models/cipher.rs`, `user.rs`, `organization.rs`
  (Membership), `collection.rs`, `two_factor.rs`.
- bitwarden/sdk @ `bitwarden-v1.0.0`: `crates/bitwarden-crypto/src/`
  (`aes.rs`, `rsa.rs`, `keys/utils.rs`, `keys/master_key.rs`, `enc_string/symmetric.rs`,
  `enc_string/asymmetric.rs`, `util.rs`), `crates/bitwarden-vault/src/cipher/`,
  `crates/bitwarden-core/src/auth/` (register.rs, login/password.rs,
  api/request/password_token_request.rs).
- bitwarden/clients `main`: `libs/legacy-crypto/src/enums/{kdf-type,encryption-type}.enum.ts`,
  `libs/legacy-crypto/src/models/enc-array-buffer.ts`,
  `libs/common/src/key-management/master-password/services/master-password.service.ts`.
- Bitwarden Security White Paper (bitwarden.com/help/bitwarden-security-white-paper/).

---

## Unverified / flagged

- `stretch_kdf_key`: single 64-byte HKDF-Expand with no info vs legacy
  `info="enc"/"mac"` — server-irrelevant (stretch is client-only), but the
  exact SDK call should be re-read before any test vectors are written.
- vaultwarden's exact stored-hash format beyond
  `PBKDF2(clientHash, random64, configIterations)` (\"double hash\", PRs
  #4913/#5060): `check_valid_password` uses an extra 1-iteration verify step —
  treat the re-hash as internal-only; never mirror its byte layout in the
  reimplementation.
- `seats: 20`, `maxStorageGb: 32767`, `productTierType: 3` are vaultwarden
  hardcodes; pick equivalents or copy for fidelity.
- Collection `permissions` object shape inferred from web-vault expectations
  (vaultwarden sends `read/manage/modify/delete`) — confirm against an
  actual `sync` capture.
- `expires_in` for access tokens: upstream default is 3600 with configurable
  lifetime; pick 3600.