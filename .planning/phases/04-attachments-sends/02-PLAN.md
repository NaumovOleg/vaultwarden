---
phase: 04-attachments-sends
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/endpoints/sends.ts, src/endpoints/accounts.ts, src/store.ts, src/handler.ts, test/sends.test.ts, scripts/e2e-vault.sh, lib/vaultwarden-stack.ts]
autonomous: true

must_haves:
  truths:
    - "Send payloads/names are encrypted strings relayed verbatim; send password is hashed client-side (SHA-256 base64) and stored, never plaintext"
    - "deletionDate is honored lazily: a send past deletionDate is treated as gone (404/not in list) at read time — no background sweeper (ponytail: single-user scope, TTL on deletionDate row is the upgrade path)"
    - "File sends reuse the attachment multipart machinery (no new upload path); accessId is the anonymous handle"
    - "sync.sends filled from SendItem rows; send JSON shape {id, accessId, name, type, maxAccessCount, accessCount, revisionDate, expirationDate, deletionDate, disabled, passwordProtected, hideEmail, object:'send'}"
  artifacts:
    - "src/endpoints/sends.ts (CRUD + access + file)"
    - "SendItem storage + sync integration"
    - "test/sends.test.ts; e2e-vault.sh extended with a text-send roundtrip"
  key_links:
    - "access flow: POST /api/sends/access/{accessId} {password?} — 401/400 when passwordProtected and hash mismatch; returns {data: {text}|file Ref…, expirationDate, passwordProtected, object:'sendAccess'}"
    - "anonymous file download GET /api/sends/{accessId}/{fileId}?t=<send access token>"
    - "POST /api/sends/file/v2 mirrors attachment v2 shape with object 'send-fileUpload' + sendResponse"
---

<objective>
Sends (text + file): CRUD, anonymous access, and sync integration — MISC-04, reusing the multipart path from plan 01.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.6 sends)
@src/endpoints/ciphers.ts
@src/objects.ts
@src/handler.ts
@src/store.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: SendItem + CRUD</name>
  <files>src/endpoints/sends.ts, src/store.ts, src/handler.ts</files>
  <action>
    - `SendItem {pk: 'SEND#{userId}#{sendId}', sk: 'SEND', id, accessId (uuid-derived hex, 10 chars), type (0|1), name (encrypted), notes|null, text: {text, hidden}|null (encrypted), file: {fileName, size, sizeName, key, id}|null, passwordHash: string|null (client SHA-256 b64 of send password), maxAccessCount: number|null, accessCount: number, expirationDate: ISO|null, deletionDate: ISO|null, disabled: bool, hideEmail: bool, revisionDate}]`
    - Store: `putSend/getSend/listSends/deleteSend` (+ Memory/Dynamo pair, pk begins_with SEND#{userId}#)
    - Endpoints (auth): `GET /api/sends` (list, lazily filters deletionDate-past/disabled-out), `GET /api/sends/{id}`, `POST /api/sends` (text: {type:0, name, text:{text,hidden}, maxAccessCount?, expirationDate?, deletionDate?, password?, disabled?, key?} → send JSON w/ `passwordProtected: !!passwordHash`), `PUT /api/sends/{id}`, `DELETE /api/sends/{id}` + `POST /{id}/delete`, `PUT /api/sends/{id}/remove-password` → 200 {}
    - sync (accounts.ts): `sends: listSends → sendJson` (reuse serializer; strip/defer file url)
  </verify>
  `npm test` green; ts-node smoke: create text send → list/get → update → password set/removed → delete → sync.sends shows it
  <done>Text sends CRUD + sync live.</done>
</task>

<task type="auto">
  <name>Task 2: file sends + access flow</name>
  <files>src/endpoints/sends.ts, src/handler.ts</files>
  <action>
    - `POST /api/sends/file/v2` (auth) {key, fileName, fileSize} → create send w/ file meta → `{object:'send-fileUpload', fileUploadType:0, url:'/api/sends/{id}/file/{fileId}', sendResponse: sendJson}`
    - `POST /api/sends/{id}/file/{fileId}` (multipart {key, data}) → PutObject `sends/{sendId}/{fileId}` → sendResponse
    - Anonymous: `POST /api/sends/access/{accessId}` {password?} → 404 when unknown/expired/deleted; passwordProtected: hash != stored → 400 w/ passwordRequired; success → `{data: {...payload}, expirationDate, passwordProtected, object:'sendAccess'}`; increments accessCount + honors maxAccessCount (exceed → 400)
    - `POST /api/sends/access` (restricted token grant) ONLY if trivial — else skip w/ ponytail note (old clients only; accessId path covers current clients)
    - File download: `GET /api/sends/{accessId}/file/{fileId}?t=` → 302 to presigned GET (or JSON url body — pin: 302 redirect, matches VW)
    - Remove-password + delete cascade file objects (deletePrefix sends/{sendId}/)
  </verify>
  `npm test` green; smoke: v2 file send → upload → anonymous access w/ + w/o password → download url; expired deletionDate → 404
  <done>File sends + anonymous access live.</done>
</task>

<task type="auto">
  <name>Task 3: e2e + phase wrap</name>
  <files>scripts/e2e-vault.sh, .planning/phases/04-attachments-sends/03-SUMMARY.md, .planning/STATE.md</files>
  <action>
    - e2e-vault.sh: append text-send create → access roundtrip + attachment upload/download byte-identical check (curl multipart; cmp)
    - 02-SUMMARY.md w/ deploy handoff (owner: redeploy, web-vault attach/detach + sends check; README 4.5MB ceiling note)
  </verify>
  `bash -n`; `npm test`; synth green
  <done>Phase 4 wrapped; deploy handoff written.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- sends roundtrip incl. password gate; file send byte-identical via access file url
- e2e-vault.sh covers attachment + send (owner-run at deploy)
</verification>

<success_criteria>
- Web vault: attach/detach in UI, sends visible and shareable (MISC-04)
- curl: multipart upload → presigned download byte-identical; anonymous send access works
- delete-cipher / delete-send removes S3 objects
</success_criteria>

<output>
After completion, create `.planning/phases/04-attachments-sends/02-SUMMARY.md` and update `.planning/STATE.md`.
</output>