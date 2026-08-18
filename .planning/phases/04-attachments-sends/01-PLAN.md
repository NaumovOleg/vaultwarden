---
phase: 04-attachments-sends
plan: 01
type: execute
wave: 1
depends_on: [03]
files_modified: [src/objects.ts, src/endpoints/ciphers.ts, src/endpoints/accounts.ts, src/endpoints/folders.ts, src/endpoints/devices.ts, src/endpoints/identity.ts, src/store.ts, src/handler.ts, src/router.ts, src/auth.ts, lib/vaultwarden-stack.ts, test/attachments.test.ts, package.json]
autonomous: true

must_haves:
  truths:
    - "Direct flow only (vaultwarden behavior): client POSTs multipart form-data {key, data} to server-relative url; file bytes transit Lambda; 6MB invoke cap ⇒ ≈4.5 MB decoded ceiling — 413 beyond it (ARCHITECTURE §4.1-4.2 decision: no Azure/presigned-PUT path)"
    - "Download = presigned GET url in the attachment JSON (vaultwarden S3 backend does exactly this); file never touches Lambda"
    - "Attachments are client-side encrypted blobs: metadata (fileName/key/size) in cipher row, bytes on S3 SSE-S3 — SSE is enough (§4.5)"
    - "Attachment rows in cipher JSON must serialize url as a fresh 5-min presigned URL per read"
    - "Cascade: permanent cipher delete / purge / deleteUser removes S3 objects"
  artifacts:
    - "src/objects.ts (ObjectStore interface: S3 + Memory impls, presign, deletePrefix cascade)"
    - "AttachmentItem on CipherItem + serializer (sizeName helper)"
    - "attachment/v2 create → {object:'attachment-fileUpload', attachmentId, url, fileUploadType:0, cipherResponse}"
    - "multipart upload (no deps, RFC 2046 parse) → PutObject → 200 cipher"
    - "GET attachment → {object:'attachment', id, url, fileName, key, size, sizeName}"
    - "DELETE attachment + variants; bucket CORS + grants + env; test/attachments.test.ts byte-identical roundtrip"
  key_links:
    - "legacy POST /api/ciphers/{id}/attachment single-call create+upload (old clients)"
    - "413 envelope when decoded bytes > 4.5 MB"
    - "AttachmentItem.id is foreign to cipher id; object keys attachments/{cipherId}/{attachmentId}"
---

<objective>
Attachment support: the v2 Direct multipart flow through Lambda to S3, presigned-GET downloads, and cleanup cascades — the last VAULT-07 requirement for the personal vault.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/ARCHITECTURE.md (§4 attachments)
@.planning/research/API-SURFACE.md (§2.3 attachments)
@src/endpoints/ciphers.ts
@src/handler.ts
@src/store.ts
@lib/vaultwarden-stack.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: ObjectStore + stack wiring</name>
  <files>src/objects.ts, lib/vaultwarden-stack.ts, src/handler.ts, src/router.ts</files>
  <action>
    - `src/objects.ts`: `interface ObjectStore { putObject(key, bytes), presignedGetUrl(key), deleteObject(key), deletePrefix(prefix) }`; `S3ObjectStore` (env ATTACHMENTS_BUCKET; @aws-sdk/client-s3 GetObjectCommand + getSignedUrl from @aws-sdk/s3-request-presigner 5-min); `MemoryObjectStore` (Map; presigned → `mem://<key>`)
    - `RouteContext.objects: ObjectStore` (like store); createHandler accepts `{store, objects}`
    - Stack: attachment bucket CORS `[allowedOrigins: [domain-from-context], allowedMethods: GET, HEAD, PUT, allowedHeaders: ['*']]` (§4.4); `bucket.grantReadWrite(handler)`; env `ATTACHMENTS_BUCKET`
    - deps: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (npm install)
  </verify>
  `tsc --noEmit` green; synth shows bucket CORS + lambda env
  <done>Object store plumbed through; S3 reachable from handler.</done>
</task>

<task type="auto">
  <name>Task 2: AttachmentItem + serializers</name>
  <files>src/store.ts, src/endpoints/ciphers.ts</files>
  <action>
    - `AttachmentItem {id, url: string (filled at serialize), fileName, key, size: number, sizeName: string, object: 'attachment'}` on `CipherItem.attachments: AttachmentItem[] | null`
    - `cipherJson`: attachments serialized with fresh presigned url (only for non-deleted ciphers — trashed items don't need urls); `attachmentCount: attachments.length` emitted (web vault uses it), keep `attachments` array too (clients ≤2024 expect it)
    - `sizeName()` helper: human bytes (VW format: 0 B, 1.2 KB, 4.5 MB, 1.3 GB)
    - store: `getAttachments` not needed — attachments live on the cipher row; no new store methods (cipher put/get covers it)
  </verify>
  ts-node smoke: cipher with 2 attachments round-trips, urls are presigned-shaped, sizeName correct
  <done>Attachments serialize canonically with live urls.</done>
</task>

<task type="auto">
  <name>Task 3: v2 create + multipart upload + legacy</name>
  <files>src/endpoints/ciphers.ts, src/handler.ts</files>
  <action>
    - `POST /api/ciphers/{cipherId}/attachment/v2` (auth) `{key, fileName, fileSize?}` → validate ownership (404 envelope), create meta row on cipher (`attachments.push({id: uuid, url: '', fileName, key, size: fileSize ?? 0, sizeName, object:'attachment'})`), save cipher, respond `{object:'attachment-fileUpload', attachmentId, url: '/api/ciphers/{cipherId}/attachment/{attachmentId}', fileUploadType: 0, cipherResponse: cipherDetails}`
    - multipart parse (RFC 2046, no deps): content-type boundary; fields `key` (JSON text) + `data` (raw bytes, base64-decoded event body); size cap: decoded `data` > 4.5 MB → 413 envelope (also if missing data/key → 400)
    - `POST /api/ciphers/{cipherId}/attachment/{attachmentId}` (that url) → PutObject `attachments/{cipherId}/{attachmentId}` (ContentType application/octet-stream), update cipher row (size/sizeName from bytes), respond 200 cipherDetails (client stores as updated cipher)
    - Legacy `POST /api/ciphers/{cipherId}/attachment` (multipart with `key`, `data`, `fileName`) → create + upload in one call → 200 cipherDetails
    - Routes: `POST /api/ciphers/:cipherId/attachment/v2`, `POST /api/ciphers/:cipherId/attachment/:attachmentId`, `POST /api/ciphers/:cipherId/attachment` (order: v2 and :attachmentId literal/param — exact-first matcher already picks literal v2)
  </verify>
  `npm test` green with test/attachments.test.ts: v2 create → upload multipart → byte-identical read; unknown cipher 404; oversize 413; legacy single-call; missing field 400
  <done>Upload works end-to-end; bytes on S3, metadata on cipher row.</done>
</task>

<task type="auto">
  <name>Task 4: download + delete + cascade</name>
  <files>src/endpoints/ciphers.ts, src/store.ts, src/endpoints/accounts.ts</files>
  <action>
    - `GET /api/ciphers/{cipherId}/attachment/{attachmentId}` → `{object:'attachment', id, url: presignedGetUrl(key), fileName, key, size, sizeName}` (fresh url per call); 404 when cipher/attachment unknown
    - `DELETE|POST /api/ciphers/{cipherId}/attachment/{attachmentId}` + `/delete` + PUT → remove row entry + DeleteObject → 200 cipherDetails (web vault detach; also the upload-cancel/rollback path)
    - Cascade: permanent `deleteCipher` (purge) → deletePrefix(`attachments/{cipherId}/`); folder delete unaffected (attachments ride the cipher); `deleteAccount` → for each cipher prefix... store.deleteUser already drops rows — add objects cleanup: in deleteAccount endpoint, iterate user's ciphers (before deleteUser) → deletePrefix per cipher
    - Soft delete (trash): keep S3 objects (restore must work); urls blanked for trashed rows in serializer
  </verify>
  tests: download url round-trip; detach removes object (Memory impl assert); purge cascades prefix; deleteAccount cleans objects; trash keeps objects + restore re-arms urls
  <done>Full attachment lifecycle: upload, download, detach, cascade on purge/account-delete.</done>
</task>

</tasks>

<verification>
- `npm test` green (new attachments suite); `tsc --noEmit`; `npm run synth`
- Byte-identical roundtrip: upload 1 KB + near-limit blob, GET bytes match exactly
- Phase summary notes 4.5 MB ceiling + README line
</verification>

<success_criteria>
- Web vault attach/detach works in UI (owner hand check at deploy)
- SDK/curl: create → multipart upload → presigned download → byte-identical
- Trash → restore keeps attachments; purge/account-delete removes S3 objects
</success_criteria>

<output>
After completion, create `.planning/phases/04-attachments-sends/01-SUMMARY.md`
</output>