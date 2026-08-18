---
phase: 03-vault-core
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/endpoints/accounts.ts, src/endpoints/identity.ts, src/store.ts, src/handler.ts, test/accounts.test.ts, test/endpoints-auth.test.ts]
autonomous: true

must_haves:
  truths:
    - "GET /api/sync returns the full bundle shape (API-SURFACE §2.1): profile with accountKeys always explicit, folders, collections [], policies [], ciphers [], domains null when excludeDomains=true, sends [], userDecryption"
    - "GET /api/accounts/profile returns the identical profile object as sync"
    - "GET /api/accounts/revision-date returns {revisionDate} in MILLISECONDS epoch (pitfall 2.2)"
    - "POST /api/accounts/keys stores publicKey/privateKey verbatim and responds per vaultwarden accounts_keys (verify at execution time)"
    - "sync?partial=true returns profile + folders only (mobile initial sync)"
  artifacts:
    - "src/endpoints/accounts.ts (profile, revisionDate, keys, sync)"
    - "profile serializer shared between /api/accounts/profile and sync"
    - "test/accounts.test.ts"
  key_links:
    - "profile ← user item (akey, keys, securityStamp, twoFactorEnabled, avatarColor)"
    - "userDecryption ← masterKeyEncryptedUserKey/masterKeyWrappedUserKey captured at register; absent → masterPasswordUnlock: null"
    - "register stores the masterKey* fields the client sends (accept-unknown-fields already in place)"
---

<objective>
Land the post-login bundle: the profile serializer, the sync response the web vault renders first, and the keys/revision-date endpoints.

Purpose: after connect/token, every client immediately calls GET /api/sync (or profile+revision-date). This plan makes the vault UI actually render (empty state is fine).
Output: byte-shaped profile + sync, unit-tested.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.1, §2.2 profile/keys/revision-date)
@.planning/research/PITFALLS.md (§2.2, §2.4, §2.5)
@src/endpoints/identity.ts
@src/store.ts
@src/auth.ts
@src/handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: profile serializer + store fields</name>
  <files>src/store.ts, src/endpoints/identity.ts, src/endpoints/accounts.ts</files>
  <action>
    Store (UserItem additions, all nullable-safe):
    - `avatarColor: string` (default '#607D8B' at register — vaultwarden default)
    - `masterKeyEncryptedUserKey: string | null`, `masterKeyWrappedUserKey: string | null` — captured from register body (`masterKeyEncryptedUserKey`/`masterKeyWrappedUserKey` top-level fields; already accepted as unknown fields today — now store them)
    - `revisionDate: string` (ISO) — set to createdAt at register; bumped on account writes (plan 03 uses it)
    - Existing: id/name/email/akey(privateKey/publicKey)/securityStamp/twoFactorEnabled/premium/enabled/creationDate
    - `profileJson(user)` helper (in accounts.ts): the exact ProfileResponseModel (API-SURFACE §2.1):
      `{id, name, email, emailVerified: true (no mail system — decision 02), premium, premiumFromOrganization: false, culture: "en-US", twoFactorEnabled, key: akey, privateKey, securityStamp, organizations: [], providers: [], providerOrganizations: [], forcePasswordReset: false, avatarColor, usesKeyConnector: false, creationDate, _status: 1, accountKeys: {publicKeyEncryptionKeyPair: {encryptedPrivateKey: privateKey, publicKey, object: "keyPair"} | null, securityState: null, signatureKeyPair: null, object: "privateKeys"}, object: "profile"}`
      - accountKeys ALWAYS present with explicit keys (pitfall 2.4); when user has no keys → keyPair null
      - `emailVerified: true` — no-email decision; revisit if mail lands
  </verify>
  `tsc --noEmit` green; ts-node smoke: register → profileJson matches shape; user without keys → accountKeys.publicKeyEncryptionKeyPair null.
  <done>Profile serializer correct and reusable; store carries the new fields.</done>
</task>

<task type="auto">
  <name>Task 2: endpoints — profile, revision-date, keys, sync</name>
  <files>src/endpoints/accounts.ts, src/handler.ts</files>
  <action>
    `src/endpoints/accounts.ts` (all `auth: true`):
    - `GET /api/accounts/profile` → profileJson(user)
    - `GET /api/accounts/revision-date` → `{"revisionDate": <epoch ms>}` (pitfall 2.2 — ms, not ISO; clients drive sync cadence off it; store epoch ms on the user item alongside ISO — keep `revisionDateMs: number` updated whenever revisionDate is)
    - `POST /api/accounts/keys` → store `{publicKey, privateKey, encryptedMasterKey?}` verbatim → respond per vaultwarden `accounts_keys` (verify exact response at execution time: `src/api/accounts.rs`; expected `{publicKey, encryptedPrivateKey, object: "keys"}`-style — pin the body)
    - `GET /api/sync` (query params): full bundle (API-SURFACE §2.1):
      - `profile: profileJson(user)`
      - `folders: []`, `collections: []`, `policies: []`, `sends: []` (empty arrays — NOT null; ciphers land in plan 02)
      - `ciphers: []` (plan 02 fills)
      - `domains: null` when `excludeDomains=true` (web vault) — otherwise `{equivalentDomains: [], globalEquivalentDomains: [], object: "domains"}` (pitfall 2.1: empty is correct, key must exist)
      - `userDecryption: {masterPasswordUnlock: {kdf: {kdfType, kdfIterations, kdfMemory, kdfParallelism} (camelCase — API-SURFACE §2.1 quirk), masterKeyEncryptedUserKey, masterKeyWrappedUserKey, salt: user.email}}` or `{masterPasswordUnlock: null}` when keys absent
      - `object: "sync"`
    - `sync?partial=true` → profile + folders only (API-SURFACE §2.1 — mobile initial sync)
    - Wire routes: `GET /api/accounts/profile`, `GET /api/accounts/revision-date`, `POST /api/accounts/keys`, `GET /api/sync` (all auth: true)
  </verify>
  `npm test` green; ts-node smoke: register → token → Bearer GET /api/sync → shape per must_haves; excludeDomains variant; partial variant; revision-date ms value == Date.now() within tolerance.
  <done>Sync bundle + profile + keys + revision-date live and shaped.</done>
</task>

<task type="auto">
  <name>Task 3: tests</name>
  <files>test/accounts.test.ts, test/endpoints-auth.test.ts</files>
  <action>
    `test/accounts.test.ts` (createHandler + MemoryStore, register → login → Bearer):
    1. profile: every field asserted (incl. accountKeys keyPair shape, emailVerified true, _status 1)
    2. profile === sync.profile (deep equal)
    3. sync full shape: all top-level keys present, arrays [], domains null (excludeDomains=true) vs domains object (default)
    4. userDecryption: user WITHOUT masterKey* → masterPasswordUnlock null; with (putUser directly) → exact camelCase kdf + salt === email
    5. partial sync → only profile+folders keys
    6. revision-date: {revisionDate} is a 13-digit ms number close to Date.now()
    7. POST /api/accounts/keys stores keys + returns pinned response body
    8. 401 without bearer on all four endpoints
    Update register tests: masterKey* fields captured (send them at register → assert stored).
  </verify>
  `npm test` fully green; `tsc --noEmit` green; `npm run synth` green (no stack change).
  <done>Bundle + serializer asserted byte-for-byte; web vault post-login screen has its data.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- sync/profile shape matches API-SURFACE §2.1 field-for-field
- revision-date ms epoch; domains null under excludeDomains; userDecryption null-safe
</verification>

<success_criteria>
- Web vault's first post-login requests (sync) all answered with correct shapes — vault UI renders (empty vault)
- Plan 02 can fill ciphers into the same bundle
</success_criteria>

<output>
After completion, create `.planning/phases/03-vault-core/01-SUMMARY.md`
</output>
