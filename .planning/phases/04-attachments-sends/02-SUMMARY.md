# Phase 4 Plan 02 — Sends (CRUD + access + file)

Status: **executed** · 115 tests green (12 suites) · tsc + bash -n green

## What shipped

- `src/endpoints/sends.ts` — SendItem CRUD + sync integration:
  - `GET /api/sends` (lazy filter: deletionDate-past / disabled hidden), `GET/POST/PUT/DELETE /api/sends/{id}`, `POST /{id}/delete`, `PUT /{id}/remove-password`
  - Password: client SHA-256 base64 stored verbatim as `passwordHash`; `passwordProtected` derived from its presence
  - File sends: `POST /api/sends/file/v2` → `send-fileUpload` + `sendResponse`, multipart upload reusing the attachment machinery (`sends/{sendId}/{fileId}`), delete cascades `deletePrefix`
  - Anonymous access: `POST /api/sends/access/{accessId}` — 400 `passwordRequired` on mismatch, 404 when unknown / deletionDate-past / disabled / expired, `maxAccessCount` honored with 400; increments `accessCount`
  - Anonymous download: `GET /api/sends/{accessId}/file/{fileId}` → 302 to presigned GET
- `src/store.ts` — `SendItem` (`SEND#{userId}#{sendId}`), put/get/list/delete + `findSendByAccessId` (Dynamo: GSI1 `SENDACCESS#{accessId}`; Memory: scan). `deleteUser` cascades SEND rows (both stores)
- `src/endpoints/accounts.ts` — `sync.sends` populated; `deleteAccount` cascades send S3 objects
- `src/endpoints/multipart.ts` — shared, **byte-exact** multipart parser operating on raw `Buffer` (`ctx.bodyBytes`); fixes utf-8 mangling of binary upload payloads (base64 → utf-8 round-trip corrupted non-ASCII bytes). Regression test: base64 event with 0x00/0xFF/0xC3 bytes is byte-identical after upload
- `scripts/e2e-vault.sh` — steps 12 (attachment upload/download byte-identical via `cmp`) + 13 (text send create → anonymous password access → sync → delete)

## Deferred / notes (ponytail)

- `POST /api/sends/access` (old restricted-token grant): skipped — current clients use the accessId path
- `POST /api/sends/{id}/access/file/{fileId}` + legacy multipart `POST /api/sends/file`: not built — v2 Direct flow is what clients use
- Send file download `t=` query param accepted-and-ignored: accessId (10 hex chars) is the unguessable handle; real HMAC token is the upgrade path
- `deletionDate` honored lazily at read time (no sweeper); 4.5 MB multipart ceiling shared with attachments
- Send file objects are not versioned/cost-guarded beyond the attachment bucket policy (same bucket)

## Owner handoff (at deploy)

1. `npm run webvault && npx cdk deploy`
2. `bash scripts/e2e-vault.sh https://<domain>` — steps 12–13 exercise attachments + sends end-to-end
3. Web vault check: Attach/Detach on a cipher, Sends page: create text send → share link → open in incognito (+ password gate), file send share + download
4. README note: 4.5 MB upload ceiling (Lambda payload limit), Sends share links work without login