---
phase: 03-vault-core
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/endpoints/ciphers.ts, src/endpoints/accounts.ts, src/store.ts, src/auth.ts, src/handler.ts, test/ciphers.test.ts, test/accounts.test.ts]
autonomous: true

must_haves:
  truths:
    - "Cipher storage keeps type payload strictly separate from cipher-level fields (pitfall 1.5: never fold name/notes/fields into login{}); sync emits canonical types"
    - "cipher create/update accept unknown fields, never reject on extras; encrypted strings relayed verbatim (pitfall 5: verbatim hash/EncString compare)"
    - "Soft delete sets deletedDate; restore clears it; purge deletes rows; bulk ids[] variants work"
    - "Cipher serializer emits explicit nulls for nullable fields (pitfall 2.5); non-matching type objects null, not absent"
  artifacts:
    - "src/endpoints/ciphers.ts (list/get/create/update/partial/delete/restore/move/archive/purge, single + bulk ids[])"
    - "CipherItem storage + serializers (cipherDetails vs cipher)"
    - "test/ciphers.test.ts"
  key_links:
    - "list/sync read CipherItem rows; serializer maps item → cipherDetails"
    - "folderId from FOLDER#{userId}#{id} or null"
    - "deletedDate filters trash view; purge deletes permanently"
---

<objective>
The cipher surface: full CRUD + trash semantics with the strict serializer (pitfall 1.5) that 2026.7.0+ clients require.

Purpose: this is where the vault actually holds data. EncStrings are opaque to us — storage is a structured envelope, values relayed verbatim.
Output: working cipher CRUD + trash lifecycle, byte-canonical shapes, unit-tested.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.1 cipher shape, §2.3 ciphers)
@.planning/research/PITFALLS.md (§1.5, §2.5)
@src/endpoints/accounts.ts
@src/store.ts
@src/handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: CipherItem storage + serializer</name>
  <files>src/store.ts, src/endpoints/ciphers.ts</files>
  <action>
    Store:
    - `CipherItem {pk: "CIPHER#{userId}#{cipherId}", sk: "CIPHER", id, type: int, name, notes, favorite: bool, reprompt: int, folderId: string|null, organizationId: null (orgs = phase 5), creationDate, revisionDate, deletedDate: string|null, key: string|null (org ciphers only; null for personal), login: LoginData|null, secureNote, card, identity, sshKey, bankAccount, driversLicense, passport: each a structured object|null — NEVER folded, fields: [...] array|null, passwordHistory: [...]|null, attachments: null (phase 4), collectionIds: []}`
    - `LoginData {uris: [{uri, match}]|null, username, password, totp, passwordRevisionDate, fido2Credentials: []|null}` — per-type payloads stored verbatim from the request (strings stay strings)
    - Store methods: `putCipher`, `getCipher(userId, cipherId)`, `listCiphers(userId)`, `deleteCipher(userId, cipherId)`; MemoryStore + DynamoStore (Query pk begins_with `CIPHER#{userId}#`, sk = CIPHER)
    - Serializer `cipherDetailsJson(item)` (in ciphers.ts):
      `{object: "cipherDetails", id, type, creationDate, revisionDate, deletedDate|null, reprompt, organizationId: null, key: null, attachments: null, organizationUseTotp: true, collectionIds: [], name, notes, fields: [...]|null, passwordHistory: [...]|null, login|null, secureNote|null, card|null, identity|null, sshKey|null, bankAccount: null, driversLicense: null, passport: null, edit: true, viewPassword: true, favorite, folderId|null, lastUsedDate: revisionDate}`
      - `previousPasswords`: omit (2025.12+ client feature; revisit)
      - `object: "cipher"` variant for create/update responses (API-SURFACE §2.3: create → cipher object; list/sync → cipherDetails)
  </verify>
  `tsc --noEmit` green; ts-node smoke: putItem with login data → cipherDetailsJson canonical; non-login type → login null.
  <done>Storage + canonical serializer live.</done>
</task>

<task type="auto">
  <name>Task 2: cipher endpoints</name>
  <files>src/endpoints/ciphers.ts, src/handler.ts</files>
  <action>
    All `auth: true`, per-user scoping (get/list return ONLY the user's items):
    - `GET /api/ciphers` → `{object: "list", data: [cipherDetails...], continuationToken: null}` (non-deleted only)
    - `GET /api/ciphers/{id}` and `GET /api/ciphers/{id}/details` → cipherDetails (details = same body)
    - `POST /api/ciphers` + `POST /api/ciphers/create` → create (body per §2.3; store type payload verbatim; unknown fields accepted; `folderId` resolved-or-null) → 200 cipher object
    - `PUT|POST /api/ciphers/{id}` → update (replace; revisionDate = now) → cipher
    - `PUT|POST /api/ciphers/{id}/partial` → merge ONLY login fields present in body (extension autofill: {login: {username?, password?, uris?}}) → cipher
    - `DELETE|POST|PUT /api/ciphers/{id}` (+ `/delete` path) → soft delete (deletedDate = now) → 200 {} (never 204 — pitfall 2.5 note)
    - `PUT|POST /api/ciphers/{id}/restore` → deletedDate = null → 200 {}
    - `PUT|POST /api/ciphers/move` → `{folderId, ids: []}` → set folderId on each → 200 {}
    - `PUT|POST /api/ciphers/archive` + `/unarchive` (bulk `{ids}`) → reprompt? NO — archive sets `deletedDate`-independent flag: keep `archived: bool` on item (vaultwarden archives via deletedDate? — verify at execution time: vaultwarden archive = set deletedDate? NO: archive is a separate soft state in newer servers; pin: implement `archived: bool` on CipherItem, sync/list include archived items, trash = deletedDate set)
      — correction, verify at execution time against vaultwarden src/api/ciphers.rs archive; if vaultwarden maps archive→deletedDate, mirror that
    - `POST /api/ciphers/purge` → body `{ids: []}` → delete rows permanently → 200 {}
    - Bulk delete: `POST|PUT /api/ciphers/delete` `{ids: []}` → soft delete each → 200 {}
    - 404 envelope when cipher id not found / not owned
  </verify>
  `npm test` green; ts-node smoke: create → get → update → partial → move → delete → list excludes → restore → purge → list empty; bulk variants; unknown id → 404 envelope.
  <done>Full personal-cipher CRUD + trash lifecycle live.</done>
</task>

<task type="auto">
  <name>Task 3: sync integration + tests</name>
  <files>src/endpoints/accounts.ts, test/ciphers.test.ts, test/accounts.test.ts</files>
  <action>
    - `GET /api/sync` now returns `ciphers: [cipherDetails...]` (all items incl. deleted ones — trash is synced; folders list likewise in plan 03)
    - `test/ciphers.test.ts`:
      1. create all 4 core types (login/secureNote/card/identity) → response shape canonical (login cipher: login object + others null; card cipher: card object + login null)
      2. create with unknown extra fields → accepted, stored; encrypted values byte-identical on read (verbatim)
      3. get/details → cipherDetails shape exact; list → object list
      4. update replaces fields; partial merges login only (username-only autofill keeps password)
      5. delete → deletedDate set, excluded from list, present in sync; restore → gone from trash
      6. move → folderId persisted; bulk delete ids[]; purge → row gone (get → 404)
      7. 404 on foreign cipher id (other user's item)
      8. 401 without bearer
    - sync test: after creating ciphers, sync.ciphers contains them with canonical shape
  </verify>
  `npm test` fully green; `tsc --noEmit` green; `npm run synth` green.
  <done>Ciphers flow through sync; trash/restore/purge proven; vault UI can render real items.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- Canonical shapes per pitfall 1.5: type payload never folded, explicit nulls
- Trash lifecycle: delete → sync shows deletedDate → restore → purge removes
</verification>

<success_criteria>
- All 4 core cipher types create/read/update/delete with real EncStrings
- Web vault renders items, trash, and edit screens (human check at phase end)
</success_criteria>

<output>
After completion, create `.planning/phases/03-vault-core/02-SUMMARY.md`
</output>
