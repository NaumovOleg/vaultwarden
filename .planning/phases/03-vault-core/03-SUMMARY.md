# Phase 03-vault-core, Plan 03 — folders, import, account management

Status: complete. See git log for commit.

## What landed

- **`src/endpoints/folders.ts`**: `folderJson` serializer + CRUD — `GET /api/folders` (list), `GET /api/folders/{id}`, `POST /api/folders`, `PUT|POST /api/folders/{id}`, `DELETE|POST|PUT /api/folders/{id}` + `/delete`. Folder delete is hard delete; member ciphers orphaned with `folderId → null` — pinned against vaultwarden source (folder delete removes FolderCipher join rows; there is no folder trash).
- **Import**: `POST /api/ciphers/import` — `{folders, ciphers, folderRelationships: [[folderIdx, cipherIdx]]}` in one call; folders created by index, relationships applied, duplicates allowed (matches vaultwarden).
- **Account management** (`src/endpoints/accounts.ts`), all verified via `verifyClientHash`:
  - `POST /api/accounts/password` — old-hash verify → re-wrap new client hash with the **same salt** (pinned against `vaultwarden src/db/models/user.rs set_password`), new akey/hint/kdf/keys, **new securityStamp** (all sessions 401, incl. current — matches VW).
  - `POST /api/accounts/kdf` — verify → new kdf → new stamp.
  - `POST /api/accounts/security-stamp` — verify → new stamp (force logout all).
  - `POST /api/accounts/verify-password` → `{MasterPasswordPolicy: {Object: "masterPasswordPolicy"}}`; wrong → 400 envelope.
  - `POST /api/accounts/delete` + `DELETE /api/accounts` — verify → `store.deleteUser` (user + devices + ciphers + folders removed).
  - `PUT|POST /api/accounts/profile` — name/avatarColor → profileJson.
- **Store**: `deleteUser(userId)` both impls (DDB: prefix queries + batch deletes; `SESS#` rows left to TTL — they 401 anyway post-delete, ponytail-noted). `UserItem.masterPasswordHint` added (register captures it now).
- **`scripts/e2e-vault.sh`** + `npm run e2e:vault`: login → sync → folder create → login-cipher create (verbatim EncString check) → list shape → update + partial merge → trash/restore → import with relationships → verify-password → folder-delete orphan check.

## Verified

- `npm test`: 100/100 green (11 suites; folders.test.ts + 6 account-mgmt tests). `tsc --noEmit` + `npm run synth` clean. `bash -n` clean.
- **Disk-leak fix**: stack.test.ts was leaking ~170MB per run into never-cleaned CDK tmp outdirs — 1067 dirs ≈ 180GB until ENOSPC. `CDK_OUTDIR=cdk.out-test` pinned (gitignored), repeated runs reuse one path.

## Decisions taken during execution

- Password change reuses the existing salt for the server wrap (VW behavior) — register's random salt stands.
- SESS# rows survive account deletion until TTL (max 30d) — dead rows: token is opaque, user row gone → every use 401s.
- Account endpoints emit `{}` 200s; wrong old password → 400 `{"Message":"Invalid password."}` (VW `err!("Invalid password")`).
- Missing `folders`/`ciphers`/`folderRelationships` arrays in import → no-op 200 (VW does not reject).

## Deferred / next

- Phase 3 code-complete. **Owner deploy handoff** (standing policy): `npm run webvault && npx cdk deploy --context vaultwarden:signupsAllowed=true` → `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online` → `npm run e2e:vault -- https://vaultwarden.free-bert.online` (script usage: `bash scripts/e2e-vault.sh https://...`) → redeploy signups=false → human web-vault check (register, login, add/edit/delete all 4 cipher types, folders, trash, import).
- Phase 4 (planned: attachments) and Phase 5 (orgs) remain.