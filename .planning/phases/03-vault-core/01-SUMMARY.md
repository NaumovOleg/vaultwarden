# Phase 03-vault-core, Plan 01 — profile + keys + sync bundle

Status: complete. Commit: (see git log).

## What landed

- **Store**: `UserItem` gains `avatarColor` (#607D8B default), `masterKeyEncryptedUserKey`/`masterKeyWrappedUserKey` (captured at register), `revisionDate` (ISO) + `revisionDateMs` (epoch ms). `CipherItem`/`FolderItem` types + `listCiphers`/`listFolders` (both impls) added now so sync is shape-complete for plans 02/03.
- **`src/endpoints/accounts.ts`**:
  - `profileJson(user)` — shared serializer; accountKeys ALWAYS present (pitfall 2.4), keyPair null when no keys; `_status: 1`, `emailVerified: true` (no-mail decision).
  - `GET /api/accounts/profile`, `GET /api/accounts/revision-date` (ms epoch, pitfall 2.2), `POST /api/accounts/keys` (verbatim store, `{publicKey, encryptedPrivateKey, object:'keys'}` response), `GET /api/sync`.
  - Sync: full bundle (profile, folders, collections [], policies [], ciphers [], domains null under excludeDomains / object otherwise, sends [], userDecryption with camelCase kdf + salt=email, or masterPasswordUnlock null); `partial=true` → profile+folders only.
- **Handler**: `RouteContext.query` from `event.rawQueryString` (API GW v2 keeps query out of rawPath).

## Verified

- `npm test`: 81/81 green (9 suites — new accounts.test.ts with profile/sync/domains/partial/revision-date/keys/401 assertions). `tsc --noEmit` + `npm run synth` clean.

## Decisions taken during execution

- `emailVerified: true` (consistent with plan 02's no-mail-gating decision).
- Sync ciphers include deleted items once Plan 02 lands (trash syncs; serializer already emits deletedDate).
- POST /api/accounts/keys response pinned to `{publicKey, encryptedPrivateKey, object: 'keys'}`.

## Deferred / next

- Plan 02: cipher CRUD + trash lifecycle + canonical serializer (pitfall 1.5); sync.ciphers fills in.
- Plan 03: folders CRUD, import, account mgmt (password/kdf/security-stamp/delete).