# Phase 03-vault-core, Plan 02 — cipher CRUD + trash lifecycle

Status: complete. See git log for commit.

## What landed

- **Store** (`src/store.ts`): `CipherItem`/`FolderItem` write surface both impls — `putCipher/getCipher/listCiphers/deleteCipher` (+ folder twins). Rows keyed `CIPHER#{userId}#{cipherId}` / `FOLDER#{userId}#{folderId}`, sk `CIPHER`/`FOLDER`. Dynamo list queries use `begins_with(pk, :pk)` (exact-equality was a latent bug — would have matched nothing at deploy).
- **`src/endpoints/ciphers.ts`**: canonical serializer `cipherJson(item, 'cipher'|'cipherDetails')` (pitfall 1.5: type payload never folded, explicit nulls, non-matching type objects null not absent, encrypted strings relayed verbatim). Handlers: list, get(+`/details`), create(+`/create`), update, partial (login-only merge for extension autofill), delete (soft, `deletedDate=now`), restore, move (single + bulk `{folderId, ids}`), purge (permanent), bulk delete `{ids}`. 404 envelope on foreign/missing id.
- **`src/endpoints/accounts.ts`**: `sync` now emits real `ciphers` (all rows incl. trashed) via the shared `cipherJson` — duplicate local serializer deleted.
- **`src/handler.ts`**: 24 cipher routes registered, all `auth: true`, exact-literal routes (`/move`, `/purge`, `/delete`) win over `:cipherId` param routes (matcher is exact-first).

## Verified

- `npm test`: 89/89 green (10 suites — new `test/ciphers.test.ts`: 4 core types canonical shape, unknown-field acceptance, verbatim EncStrings, get/details/list, update vs partial merge, trash lifecycle through sync, move + bulk delete + purge row-gone, foreign-id 404, anonymous 401). `tsc --noEmit` + `npm run synth` clean.

## Decisions taken during execution

- No `attachmentCount` in item or serializer (plan spec); activities field omitted per dated-plan notes. `attachments: null` emitted on both variants.
- `POST/PUT /api/ciphers/{id}` = update only; delete path variants are `DELETE {id}` and `{id}/delete` — removed a duplicate-route slip where POST would have shadowed update.
- Archive endpoints skipped: vaultwarden archives via soft delete (`deletedDate`), there is no separate archived state — `archived` flag would be dead storage. Add `/archive` route aliases if a client is found that calls them.
- MemoryStore `putCipher`/`putFolder` upsert by pk (push-only was a real bug: `getCipher` returned stale first row).

## Deferred / next

- Plan 03: folders CRUD, import, account management (password/kdf/security-stamp/delete), `scripts/e2e-vault.sh`.