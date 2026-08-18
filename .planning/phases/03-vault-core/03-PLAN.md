---
phase: 03-vault-core
plan: 03
type: execute
wave: 3
depends_on: [01, 02]
files_modified: [src/endpoints/folders.ts, src/endpoints/ciphers.ts, src/endpoints/accounts.ts, src/endpoints/identity.ts, src/store.ts, src/handler.ts, test/folders.test.ts, test/accounts.test.ts, scripts/e2e-vault.sh, package.json]
autonomous: true

must_haves:
  truths:
    - "Folders CRUD complete (API-SURFACE §2.4: {id,name,revisionDate,object:'folder'}); folder deletion nulls folderId on member ciphers (vaultwarden: ciphers keep folderId? — verify at execution time; folder delete either nulls or keeps orphans per vaultwarden, pin the behavior)"
    - "POST /api/ciphers/import ({folders, ciphers, folderRelationships}) imports in one call"
    - "Account endpoints: kdf change (stamp invalidation), master-password change (verify old, rehash, keys, stamp+session cascade), security-stamp revoke-all, delete account"
    - "verify-password returns MasterPasswordPolicy or {} (API-SURFACE §2.2)"
  artifacts:
    - "src/endpoints/folders.ts"
    - "import handler + folderRelationships resolution"
    - "account password/kdf/security-stamp/delete handlers"
    - "test/folders.test.ts + account-mgmt tests; scripts/e2e-vault.sh (cipher+sync curl matrix)"
  key_links:
    - "folder delete → orphaned ciphers (pin behavior at execution time)"
    - "password change → new securityStamp → all sessions 401 (existing middleware)"
    - "kdf change → securityStamp invalidated (revocation via existing mechanism)"
---

<objective>
Folders, import, and account management: the remaining vault-core surface that makes the web vault fully usable and closes Phase 3.

Purpose: folders organize the vault; import powers migration; account endpoints handle security-critical flows (password/kdf/delete).
Output: folders + import + account mgmt, e2e-vault.sh harness, phase summary + deploy handoff.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.2 accounts, §2.3 import, §2.4 folders)
@.planning/research/PITFALLS.md (§2.9 stamp)
@src/endpoints/ciphers.ts
@src/endpoints/accounts.ts
@src/store.ts
@src/handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: folders CRUD</name>
  <files>src/endpoints/folders.ts, src/store.ts, src/handler.ts</files>
  <action>
    - `FolderItem {pk: "FOLDER#{userId}#{folderId}", sk: "FOLDER", id, name, revisionDate}`; Store: putFolder/getFolder/listFolders/deleteFolder (+ MemoryStore/DynamoStore; Query begins_with FOLDER#{userId}#)
    - Endpoints (auth: true): `GET /api/folders` → list shape; `GET /api/folders/{id}` → folder|404; `POST /api/folders` {name} → folder; `PUT|POST /api/folders/{id}` → update → folder; `DELETE|POST /api/folders/{id}` + `/delete` → delete → 200 {}; folder JSON = `{id, name, revisionDate, object: "folder"}`
    - Deletion semantics: verify at execution time against vaultwarden delete_folder (vaultwarden nulls folder_id on member ciphers — pin; our CipherItem.folderId set to null for members)
    - Sync (plan 01) now fills `folders: [folderJson...]`
  </verify>
  `npm test` green; ts-node smoke: create → list → get → update → delete → ciphers in it orphaned per pinned behavior; sync.folders populated.
  <done>Folders live and synced.</done>
</task>

<task type="auto">
  <name>Task 2: import</name>
  <files>src/endpoints/ciphers.ts, src/handler.ts</files>
  <action>
    - `POST /api/ciphers/import` (auth: true): body `{folders: [{name}], ciphers: [cipher objects], folderRelationships: [[folderIdx, cipherIdx]]}` (API-SURFACE §2.3)
    - Create all folders (or reuse by name), create ciphers, apply relationships (folder index → cipher index); duplicate imports allowed (no dedupe — matches vaultwarden)
    - Respond 200 `{}`; unknown fields accepted
  </verify>
  `npm test` green; ts-node smoke: import 2 folders + 3 ciphers + relationships → sync shows folders + ciphers with folderIds.
  <done>Import works in one call.</done>
</task>

<task type="auto">
  <name>Task 3: account management endpoints</name>
  <files>src/endpoints/accounts.ts, src/endpoints/identity.ts, src/store.ts, src/handler.ts</files>
  <action>
    (auth: true, all verify old master password via verifyClientHash unless noted):
    - `POST /api/accounts/password` — body {masterPasswordHash (old), newMasterPasswordHash, key, masterPasswordHint, kdf{kdfType, kdfIterations, kdfMemory, kdfParallelism}, keys{publicKey, privateKey}}: verify old hash → store new hash (server 600k wrap), new akey, hint, kdf, keys → **new securityStamp** (revokes all sessions incl. current — client re-logs-in; matches vaultwarden) → 200 {}; wrong old → 400 envelope
    - `POST /api/accounts/kdf` — {kdf{...}, masterPasswordHash}: verify → store kdf → new securityStamp → 200 {}
    - `POST /api/accounts/security-stamp` — {masterPasswordHash}: verify → new securityStamp → 200 {}
    - `POST /api/accounts/verify-password` — {masterPasswordHash}: verify → `{MasterPasswordPolicy: {Object: "masterPasswordPolicy"}}`; wrong → 400
    - `POST /api/accounts/delete` + `DELETE /api/accounts` — {masterPasswordHash}: verify → delete user + devices + sessions + ciphers + folders → 200 {} (rows: delete by pk prefix USER#/CIPHER#/FOLDER#; SESS#/TFA#/RATE# — SESS# items reference userId; delete via known tokens impossible without GSI → ponytail: delete USER#/CIPHER#/FOLDER# rows + all SESS# items found via... store.deleteUser(userId) scans pk prefixes; sessions expire via TTL anyway)
      — ponytail comment: session rows for deleted user linger until TTL (max 30d); acceptable, note it
    - `PUT|POST /api/accounts/profile` — {name, avatarColor?} → update → profileJson
    - Store: `deleteUser(userId)` — remove user + all CIPHER#/FOLDER#/DEV# rows for the user (per-user Query+batch delete)
  </verify>
  `npm test` green; ts-node smoke: password change → old session 401s (stamp) → login with new hash works; kdf change → prelogin reflects; security-stamp → sessions die; delete → login 400 + all data gone.
  <done>Security-critical account flows work; sessions cascade via stamp.</done>
</task>

<task type="auto">
  <name>Task 4: e2e-vault.sh + phase wrap</name>
  <files>scripts/e2e-vault.sh, package.json</files>
  <action>
    - `scripts/e2e-vault.sh <url>` (like e2e-auth.sh): login → sync (profile+folders+ciphers present) → create folder → create cipher (all 4 types) → list → update → move to folder → delete → trash sync shows deletedDate → restore → purge → import → verify counts; PASS/FAIL + non-zero exit
    - `"e2e:vault": "bash scripts/e2e-vault.sh"` in package.json
    - Wrap: 03-SUMMARY.md with deploy handoff (owner: deploy, run e2e-auth + e2e-vault, human web-vault check — create account → login → add/edit/delete logins, notes, cards, identities, folders, trash, import)
  </verify>
  `bash -n scripts/e2e-vault.sh`; usage error without URL; `npm test` + synth green.
  <done>Phase 3 harness + handoff complete.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- Folders CRUD + import + account flows covered by tests
- e2e-vault.sh green on deployed stack (owner)
</verification>

<success_criteria>
- Web vault fully usable for personal vaults: create account → login → add/edit/delete all 4 cipher types, folders, trash, import
- Security flows (password/kdf/delete) cascade session revocation
</success_criteria>

<output>
After completion, create `.planning/phases/03-vault-core/03-SUMMARY.md` and update `.planning/STATE.md`.
</output>
