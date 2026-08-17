# Architecture recommendation: serverless Bitwarden-compatible backend

Research for reimplementing the Vaultwarden-compatible API on AWS Lambda + DynamoDB + S3, deployed with CDK v2. No containers, no EFS, no SQLite. Scope: single-owner (solo) password vault, web vault + mobile/desktop/CLI clients, personal-use orgs treated as a later phase.

Key fact that shapes everything else: **clients are fixed**. We cannot change what the Bitwarden OSS clients send. Every design decision below was checked against actual client code (bitwarden/clients) and Vaultwarden server code (dani-garcia/vaultwarden), not against API docs.

---

## 1. Component layout & origin strategy

### 1.1 Recommended topology

```
                                            ┌───────────────────────────────────────┐
                                            │  CloudFront  (vault.example.com, ACM  │
                                            │  cert, WAF optional)                 │
                                            └────────────┬──────────────────────────┘
                        default /*                      │  Behavior routing by path prefix
   ┌─────────────────────────────────┐                  │
   │ S3 bucket: web vault static     │    /api/*  /identity/*  /icons/*  /alive
   │ (BucketDeployment, OAC)         │                  │
   └─────────────────────────────────┘    ┌─────────────▼──────────┐
                                          │ API Gateway HTTP API   │
                                          │ (single catch-all      │
                                          │  route $default/*)     │
                                          └─────────────┬──────────┘
                                                        ▼
                                          Lambda Node 22 (one function,
                                          URLPattern-style router inside)
                                          ▼
                       DynamoDB (single table)   S3 (attachments,
                                                 icons cache)
```

**Verdict: CloudFront in front of everything, one API Gateway HTTP API with a single catch-all route, one Lambda.** Not Function URLs, not per-path Lambda integrations.

Rationale:

- **Same-origin is mandatory.** Self-hosted Bitwarden (Vaultwarden included) serves web vault + API + identity + icons from one origin. The web vault computes API endpoints from its `config.json` (`urls.server`); when that equals the page origin, all requests are same-origin (see [web vault config](https://github.com/bitwarden/clients/blob/main/apps/web/src/config)) — **CORS then never fires for the vault itself**. Desktop/mobile/CLI clients are not browsers, so they have no CORS at all. The only place CORS ever matters is cross-origin fetches of presigned S3 attachment URLs (see §4), solved with bucket CORS.
- CloudFront is required anyway: S3 website endpoints can't do HTTPS on a custom domain; only CloudFront can put the static web vault (S3) and the API (HTTP API or Function URL) behind one hostname with path-based routing. Given it's required, it also buys: edge CDN for web vault + icons, WAF, and a place to cache `/icons/*`.
- **HTTP API over Function URL**: identical Lambda payload format and sync 6 MB limit, but HTTP API adds request throttling, WAF attach (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-waf.html), access logging, and a standard Lambda-proxy integration; cost is the same order ($1.00/M requests, https://aws.amazon.com/api-gateway/pricing/). Function URL offers nothing we need (long timeouts here are useless). HTTP API route-level integration timeout is 30 s — plenty.
- **Single catch-all route** (`$default` route, `{proxy+}`-style, payload format 2.0) → one Lambda. Per-path integrations (300-route quota, https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) buy nothing: the routing work is 30 lines in the Lambda and keeps cold-start parallelism at 1 function (a second icon-fetching lambda would give a separate cold start for the same 30 s budget).

CloudFront behaviors:

| Path prefix | Origin | Cache | Notes |
|---|---|---|---|
| `/api/*`, `/identity/*`, `/alive`, `/now` | HTTP API | none | must stay dynamic; `/api/sync` must not be cached (auth + freshness) |
| `/icons/*` | HTTP API | TTL ~7 d (404s: 1 h) | icon CDN edge cache; long-lived → near-zero latency after first fetch |
| default `/*` | S3 web vault bucket (OAC) | hashed assets immutable/long; `index.html`, `config.json` no-cache | |

CORS configuration: **none anywhere in API Gateway/CloudFront** (same-origin). Bucket CORS on the attachment bucket only (§4.4).

### 1.2 Endpoint inventory the Lambda router must cover

From vaultwarden routes (src/api/mod.rs) and identity routes (src/api/identity.rs), the path families (all paths relative to origin, no `/api` prefix on identity and icons):

- `POST /identity/connect/token` (form-encoded: `grant_type=password|refresh_token`, `username`, `password`, `deviceIdentifier`, `deviceType`, `deviceName`, `client_id`, `scope`, `twoFactorToken`/`twoFactorProvider` on 2FA)
- `GET /identity/accounts/prelogin` (`email` query param)
- `POST /identity/two-factor` (second factor verification step of login)
- `GET /identity/.well-known/openid-configuration` (some clients probe; static JSON, 404-tolerant)
- `GET|POST|PUT|DELETE /api/accounts/*` (profile, keys, password, security-stamp change, email verification, delete)
- `GET /api/sync` (the big one, §3.3)
- `/api/ciphers` + `/api/ciphers/{id}` (+ `attachment`, `attachment/v2`, `attachment/{id}`, `.../delete`, `.../share`, `.../restore`, `.../import` legacy XML, `.../export`)
- `/api/folders`, `/api/sends` (+ `/access/{accessId}/{key}` for unauthenticated send download)
- `/api/devices...`, `/api/hibp`, `/api/emergency-access/*` (phase 2), `/api/organizations`, `/api/collections`, `/api/groups`, `/api/policies`, `/api/events` (phase 2, orgs)
- `GET /icons/{domain}/icon.png` (+ `/{size}` variants on some clients)
- `GET /alive`, `GET /now`, `GET /version` (health checks; Docker-less probes deserve a stable `200`)

### 1.3 Custom domain

ACM cert (us-east-1 for CloudFront) + Route53 alias, or just use the CloudFront default `*.cloudfront.net` hostname for a first cut (web vault `config.json` accepts any server URL; the web vault works on a *.cloudfront.net origin). Same-origin logic is independent of domain.

---

## 2. Lambda runtime & packaging

- **Runtime: Node.js 22** (LTS, current AWS runtime line, https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html).
- **Packaging: esbuild via CDK `NodejsFunction`** (aws-cdk-lib/aws-lambda-nodejs). Single handler, one bundle. Everything in-repo + `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (+ `@aws-sdk/client-s3` if we use SDK presigning). Tree-shaken bundle target ≈ **150–400 KB** → cold start ≈ 300–600 ms, warm ≈ 2–15 ms (256 MB memory is plenty; bump to 512 MB only if sync gzip at >1 MB payloads shows up in CloudWatch).
- **Router: hand-rolled, no framework.** A tiny path-pattern matcher (compile `"/api/ciphers/:id/attachment/:attId"`-style patterns once to regexes, iterate a ~40-entry route table) — ~60 lines, zero deps, no Express (~2 MB + handler soup), no `URLPattern` (still build-flagged in some Node versions; a 60-line matcher removes the uncertainty). Express-on-Lambda is a known anti-pattern here: nothing about this API needs middleware stacking, and every dep costs cold start.
- **Response streaming: not needed.** All responses are JSON ≤ ~6 MB (sync) or icon bytes ≤ 100 KB.
- **Hard limits that bind (both documented at https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html):**
  - Lambda synchronous invoke payload: **6 MB request & response** — and API Gateway base64-encodes binary bodies, so multipart attachment uploads cap at ≈ **4.5 MB decoded** (§4.2). HTTP API itself allows 10 MB (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) — Lambda is the bottleneck, not the gateway.
  - 30 s HTTP API integration timeout (won't be hit; DDB round trips are ms).
- **Warm/cold start stance:** cold starts are rare for a solo user (traffic is a handful of requests/day with long idle gaps — every request may be cold). 300–600 ms cold is acceptable for a password app and cheaper than provisioned concurrency. **Provisioned concurrency: rejected (YAGNI).** If latency ever matters at <5 concurrent users, the dial is trivially turned later; it's a CDK one-liner.
- **gzip:** clients send `Accept-Encoding: gzip`; compress sync + cipher-list responses in the Lambda (node `zlib.gzipSync` on payloads > ~1 KB, set `Content-Encoding: gzip`, `isBase64Encoded: false` for text). HTTP API has no built-in compression for Lambda integrations (unlike REST APIs), so do it in code. Streaming its own payload is unnecessary.

---

## 3. DynamoDB single-table design

Single-table it is (the natural DynamoDB pattern per https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html and the canonical single-table modeling write-ups at https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-modeling-nosql.html) — with one honest caveat: the **org/collection membership graph (many-to-many) is where single-table hurts most**; for the solo-user scope it's fine, and org support is phase 2 anyway.

### 3.1 Key schema

Table `vault` (single table), on-demand capacity (§6), TTL on session items. Entity type is implied by PK/SK prefixes, not stored twice.

| Entity | PK | SK | Notes |
|---|---|---|---|
| User profile | `USER#{userId}` | `PROFILE` | `email`, `passwordHash`, `kdfType`, `kdfIterations`, `kdfMemory`, `kdfParallelism`, `securityStamp`, `akey` (master-key-encrypted user key), `privateKey`, `publicKey`, `premium`, `createdAt`, `avatarColor` |
| User by email | *(GSI1)* | — | `GSI1PK = EMAIL#{email}`, `GSI1SK = PROFILE`. Low write volume |
| Access/refresh session | `SESS#{token}` | `TOKEN` | `userId`, `deviceId`, `type: access\|refresh`, `stamp` (securityStamp snapshot), `ttl` args: access 1 h, refresh 30 d. Direct GetItem — token is the key, no GSI |
| Device | `USER#{userId}` | `DEV#{deviceId}` | `name`, `type`, `pushToken`, `lastUsed` |
| Cipher (user-owned) | `USER#{userId}` | `CIPH#{cipherId}` | full cipher JSON incl. `folderId`, `favorite`, `reprompt`, `attachments[]` (metadata, §4), `deletedDate`, `revisionDate` |
| Folder | `USER#{userId}` | `FOLD#{folderId}` | |
| Send | `USER#{userId}` | `SEND#{sendId}` | `accessId`, `key`, `maxAccessCount`… |
| Send by accessId | *(GSI2)* | — | `GSI2PK = SENDACC#{accessId}` — public send link lookup |
| 2FA config | `USER#{userId}` | `TFA#{provider}` | TOTP/Duo/WebAuthn configs, `verified` flag |
| 2FA remember | `TFAREM#{token}` | `TOKEN` | long-lived remember-me allowlist |
| *(phase 2, orgs)* Org: `ORG#{orgId}\|ORG`; org cipher: `ORG#{orgId}\|CIPH#{id}`; membership: `USER#{userId}\|ORGMEM#{orgId}` (role, accessible collection ids); collection: `ORG#{orgId}\|COLL#{id}`; collection-cipher edge: `COLL#{collectionId}\|CIPH#{cipherId}`; invite: `ORG#{orgId}\|INV#{email}`; policy: `ORG#{orgId}\|POL#{type}` | | | org phase kept out of the hot path |

Entity inventory mirrors vaultwarden's SQL schema (https://github.com/dani-garcia/vaultwarden/tree/main/migrations — 55 migrations: users, ciphers, folders, collections, collection_cipher, orgs, org_policies, devices, attachments, twofactor types incl. remember, invites, emergency access, groups, events, auth requests, sends, push_uuid, sso). Deferred entities (emergency access, events, SSO, groups) get items in phase 2 without schema change — single-table absorbs them.

### 3.2 Access patterns per endpoint

| Endpoint | DynamoDB pattern |
|---|---|
| `prelogin` (by email) | GSI1 GetItem — returns kdf params + securityStamp |
| `connect/token` password grant | GSI1 email → verify hash → GetItem USER → PutItem sessions × 2 (access+refresh) → Put/Update DEVICE |
| `connect/token` refresh grant | GetItem `SESS#{refreshToken}` → validate device+stamp → rotate (§5) |
| every authenticated `/api/*` | GetItem `SESS#{accessToken}` + GetItem `USER#{userId}\|PROFILE` (stamp check) — ~2–4 ms, no GSI |
| `GET /api/sync` | **4 parallel queries**: ciphers (Query `USER#\|CIPH#`), folders (`FOLD#`), sends (`SEND#`), memberships (`ORGMEM#`, phase 2) → assemble (§3.3) |
| cipher CRUD | GetItem / PutItem / UpdateItem / DeleteItem on `USER#\|CIPH#` |
| attachment create v2 | PutItem attachment metadata into cipher item + presign (§4) |
| send access (public link) | GSI2 GetItem by accessId |
| org vault (phase 2) | Query `ORG#\|CIPH#` + filter by membership's accessible collection ids |

### 3.3 Sync: assemble-on-read, not an aggregate

**Recommendation: assemble the sync response on read from the per-item rows; do NOT maintain a cached `UserVault` aggregate item.**

- Payload math: a cipher item ≈ 500–900 B JSON (fields, uris, notes, attachment metadata). 500 ciphers ≈ 300–400 KB; the sync response additionally carries folders (~50 B each), sends, policies, profile — call it **~0.5 MB for a heavy solo vault**. Comfortably under the 6 MB Lambda cap; typical solo vault is 50–200 KB.
- Assemble = 4–5 parallel `Query` calls in one Lambda invocation (~10–25 ms total in DynamoDB, never paginates below ~5k ciphers). Read-side cost stays proportional to actual payload, always consistent, and writes stay single-item (no write-amplification).
- An aggregate item would need: every cipher/folder/send write to rewrite the whole vault item (multi-KB update on every edit, can't be atomic without conditional logic), plus a staleness problem when an update to item X and the aggregate race. Sole merit (1 query instead of 4) is not worth the correctness tax — classic anti-pattern in the single-table guidance.
- Only escape hatch: if a vault ever exceeds ~4 MB, gzip (§2) already halves wire size and the client tolerates slow sync; the aggregate stays YAGNI.

### 3.4 GSI summary

- **GSI1** `EMAIL#` — login path (prelogin + password grant + invite/search by email). Low volume; sparse (only user items).
- **GSI2** `SENDACC#` — public send access links. Needed because access links are unauthenticated (no session join possible).
- **No by-org GSI**: org ciphers are read via the org PK query (phase 2). **No by-token GSI**: sessions are direct-key `SESS#{token}` — this is why opaque tokens (rather than JWTs with DB lookups by user) were chosen in §5.

---

## 4. Attachments — the full flow, verified against client code

This is the one area where naive serverless assumptions break, so it gets the full treatment. Three flows exist in the wild; what follows is what the clients actually do (bitwarden/clients source: `libs/common/src/platform/services/file-upload/*.ts`, `libs/common/src/vault/services/file-upload/cipher-file-upload.service.ts`, enums `FileUploadType { Direct = 0, Azure = 1 }`).

### 4.1 Upload, vaultwarden-compatible (Direct, type 0) — what we must implement

1. Client: `POST /api/ciphers/{cipherId}/attachment/v2` with JSON `{key, fileName, fileSize, adminRequest?}` (client: `cipher-file-upload.service.ts`).
2. Server: create attachment metadata (encrypted fileName, key, size), respond `{object: "attachment-fileUpload", attachmentId, url, fileUploadType: 0, cipherResponse: {...}}` — vaultwarden always answers `url` = **a server-relative URL** like `/api/ciphers/{cipherId}/attachment/{attachmentId}` (`post_attachment_v2` in src/api/core/ciphers.rs).
3. Client: **POSTs `multipart/form-data` to that URL** with one field `data` = the encrypted file blob (`bitwarden-file-upload.service.ts`). **The file bytes transit the server.** Vaultwarden then streams to storage (OpenDAL → S3 if configured; our Lambda: buffer ≤ limit, `PutObject` to S3, delete old object if replacing).
4. Server responds 200 + the cipher JSON; `{attachmentId}` is echoed back.

Implication: **with stock clients there is no "client uploads straight to S3" step in the Direct flow**, and a presigned URL substituted into `url` cannot work — the client will POST multipart form data to it, and S3's form-POST (`POST /bucket/key` with signed policy fields) rejects an unsigned form that lacks `policy`/`x-amz-signature` fields. **Documenting this precisely because many serverless designs assume presigned-PUT "just works" — it does not, for the Direct flow.**

Consequence for Lambda: uploads are bounded by the **6 MB synchronous invoke limit**, and multipart base64 overhead cuts usable file size to ≈ **4.5 MB**. That is the accepted ceiling for the Direct flow; a >6 MB attachment is an error (`413`/`500`). This is the single biggest functional regression vs. Vaultwarden and must be stated in the README.

### 4.2 Upload, Azure-style (type 1) — presigned PUT IS compatible, with one catch

Upstream Bitwarden's cloud returns `fileUploadType: 1` and an Azure Blob Storage SAS URL. Client code (`azure-file-upload.service.ts`):

- ≤ 256 MiB: raw `PUT {url}` with headers `x-ms-blob-type: BlockBlob`, `x-ms-date`, `x-ms-version` (copied from the url's `sv` query param), **asserts `status === 201`**.
- \> 256 MiB: block staging (`PUT {url}?comp=block&blockid=...`, then `PUT {url}?comp=blocklist` with XML) with URL renewal via `renewFileUploadUrl`.

A plain S3 **presigned PUT** satisfies the ≤ 256 MiB single-blob path (unsigned extra headers like `x-ms-blob-type` are legal on a SigV4 presigned URL; `sv` absent → `x-ms-version` header is dropped by the client). Two blockers keep us off this path today:

1. **Status code**: S3 `PutObject` returns `200`, client requires `201` → hard client-side failure. Only a Lambda@Edge origin-response rewrite (200→201 on that path) or a proxy would fix it — added moving parts for the flow.
2. Multi-block (`>256 MiB`) Azure semantics (`?comp=block`) have no S3 equivalent; would need a translation layer (or cap attachment size at 256 MiB).

**Decision: ship the Direct flow only (exactly what vaultwarden self-hosters run today), cap ≈ 4.5 MB, document it.** Revisit Azure-style presigned PUT + Lambda@Edge status rewrite only if >6 MB attachments become a hard requirement. [ponytail: the Azure trick is documented here as the upgrade path; implementing it now would be speculative complexity]

### 4.3 Download — presigned GET, and this one is trivially serverless

Two client paths:

1. **v2 JSON + fetch(url)**: `GET /api/ciphers/{cipherId}/attachment/{attachmentId}` returns `{object:"attachment", id, size, sizeName, fileName, key, url}`; the client `fetch()`es `url` directly (web `download-attachment.component.ts`, desktop/CLI equivalently). **Vaultwarden with an S3 backend already puts a presigned S3 GET URL in that `url` field** (`Attachment::get_url` → `operator.presign_read(..., 5 min)` in src/db/models/attachment.rs). So: *our v2 download = generate 5-min presigned GET in Lambda, return it — file never touches Lambda.* Zero new surface; this is literally the vaultwarden-S3 behavior.
2. Legacy `GET /api/ciphers/{cipherId}/attachment/{attachmentId}/download` (streamed by vaultwarden over FS): keep it as a 302 → presigned GET (or the same presigned URL as body) for old clients. Not needed by current clients; implement as redirect only if a client proves to call it.

### 4.4 CORS we cannot avoid

Browser clients fetch the presigned URL cross-origin (`bucket.s3.<region>.amazonaws.com`). **Configure CORS on the attachment bucket**: `AllowedOrigins` = vault origin(s) + `*`-able, methods `GET, HEAD, PUT`, `AllowedHeaders: *`. This is standard for presigned-URL access (https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingPresignedURL.html).

### 4.5 Bucket hardening

- No public access; presigned URLs are the only access path (upload = server-side PutObject in Direct flow, download = presigned GET).
- Object keys `attachments/{cipherId}/{attachmentId}` (vaultwarden layout `{cipher}/{attachment}`, attachment.rs:54). Prefix by owner scope only if phase-2 orgs demand it.
- Cipher delete cascades to object deletes from the Lambda (DeleteObject per attachment; block delete / delete-batch optional later).
- Encryption: SSE-S3 (default) is fine — the *payload is already client-side encrypted* (that's the whole Bitwarden model); only metadata (fileName/keys) is ours to protect, and that lives encrypted in DynamoDB.

---

## 5. Auth & token issuance

### 5.1 Recommendation: opaque tokens in DynamoDB, no JWT

**Recommend: opaque random tokens (e.g. 32 bytes hex via `crypto.randomBytes`) stored as session items (§3.1), not JWTs.**

Facts driving this (verified in vaultwarden src/auth.rs + src/api/identity.rs and client behavior):

- **Clients never verify the access token signature.** They store it, send `Authorization: Bearer <token>` on every `/api/*` request, and that's it. The server is the only verifier ("Bearer token authentication", src/auth.rs). A JWT's signature is verified by nobody in this system.
- Therefore JWT buys: nothing (crypto properties unused) and costs: HMAC secret management (Secrets Manager/SSM), rotation policy, clock skew, and — critically for this design — **you still need a store to revoke** (logout, security-stamp change, compromised device), which is the whole point of sessions. Vaultwarden itself uses JWTs but keeps a devices table with refresh tokens and stamp claims; its JWT is effectively bearer-key indirection that we can skip.
- Opaque-token cost: 1–2 `GetItem` calls per request (§3.2, ≈2–4 ms) — the same DB round-trip a JWT design needs anyway for revocation/stamp checks.

### 5.2 Token semantics

- Access token: 1 h TTL (`ttl` attribute = epoch, DynamoDB TTL sweep: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html). Item: `SESS#{token}` + `stamp` snapshot.
- **Stamp check = revocation**: every authenticated request also reads `USER#{id}|PROFILE` and 401s if `securityStamp` ≠ session's `stamp`. Password change / "log out all devices" = bump stamp; all previously issued sessions die without enumeration (no "delete all sessions for user" query needed — this is why the stamp snapshot design is the lazy correct one).
- Refresh token: 30 d, **rotation on every refresh**: validate item + device match → issue new access (1 h) + new refresh (30 d), delete the used refresh item, keep the old access session until its TTL (clients in flight). No rotation-grace window (offline clients just re-login; solo-user scope).
- `/identity/connect/token` response shape (from src/api/identity.rs `authenticated_response`): `{access_token, expires_in, token_type: "Bearer", refresh_token, Key, PrivateKey, Kdf, KdfIterations, KdfMemory, KdfParallelism, ResetMasterPassword, ...}` — `Key`/`PrivateKey` are from the user profile; password grant additionally returns the master-key-wrapped key block. 2FA-incomplete flow: HTTP 402 + `TwoFactorProviders` + `twoFactorToken` (short-lived, store as `SESS#`-typed item `TFA#` with 5-min TTL), then `POST /identity/two-factor` completes login.

### 5.3 KDF compatibility (crypto, must-get-right)

- `prelogin` returns the user's `kdfType` (0 = PBKDF2-SHA256, 4 = Argon2id), `iterations`, `memory`, `parallelism`; login verifies `PBKDF2-SHA256` via node `crypto.pbkdf2Sync` (stdlib, no deps).
- **Argon2id has no Node stdlib implementation** — needs a WASM dep (`argon2-browser` or similar, ~1 MB bundle) or a pure-JS impl, only on the login path. Decision: add later iff a real user has Argon2id accounts; stock Vaultwarden default is PBKDF2. Flagged as an open build dependency.
- Hash scheme to replicate exactly (bitwarden spec): master key = PBKDF2(password, salt=email, iterations, SHA-256); stored hash = PBKDF2(masterKey, password, 1, SHA-256) — belong in implementation notes, listed here so the design keeps the columns (`passwordHash` etc.) on the user item.

### 5.4 Secrets

No signing keys needed (opaque tokens). What still lives in SSM Parameter Store: DB-encrypted fields stay in DDB (fine — client-side encrypted), anything secret at rest in Lambda env: none so far; SMTP creds (email verification/new-device mails) if/when email is implemented; admin/org API key for `/api/.../api-key` returns. Keep Lambda env vars non-secret, pull secrets from SSM at cold start.

---

## 6. Costs & latency

### 6.1 Cost model — solo user (on-demand, no reservations)

- DynamoDB on-demand (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html): per-request billing. Realistic load: 50 vault opens/day × (sync ≈ 4×0.5 KB reads + 2 auth GetItems ≈ 1 KB) + a few writes/day. **≈ $0.01–0.10/mo.** Provisioned would require capacity planning for zero savings at this scale — on-demand, no reservations consideration.
- API Gateway HTTP API: $1.00/M requests — thousands/mo → **<$0.01**.
- Lambda: 256 MB, ~10–50 ms warm, gzip sync occasionally 100 ms — **<$0.01** (icons add ~300 ms/cold domain fetch).
- CloudFront: ~50k req/mo ≈ **$0.05**; data egress ≈ 2–5 GB/mo ≈ $0.20 (vault is tiny; icons cache cuts most repetition).
- S3: few MB → ~$0.01. Route53 hosted zone if custom domain: $0.50/mo (only real recurring line).
- **Total: ≈ $1/mo, dominated by the domain.** Icons burst (a vault with 1,000 logins cold-fetching favicons) is the only spike; CloudFront TTL absorbs it after first pass.

### 6.2 Latency budget (per region)

| Step | Warm | Cold |
|---|---|---|
| CloudFront edge → regional origin | +10–25 ms | — |
| HTTP API → Lambda | +2–5 ms | +300–600 ms |
| Lambda handler (router + DDB) | 5–25 ms | (included) |
| sync (4 parallel queries + gzip) | 15–60 ms | (included) |

p99 warm API: **~50–100 ms**; p99 cold: **~400–700 ms** for the first request after idle (solo user: most requests!). Acceptable for a password manager. Provisioned concurrency rejected (§2); if annoyance ever materializes, it's a CDK switch, not a redesign.

---

## 7. CDK stack structure

Single repo, two stacks (data vs. edge — the classic split; data deploys are rare and must not be coupled to daily service deploys):

**Stack 1 — `VaultData`** (region-locked, rarely re-deployed):
- `Table` (`vault`, on-demand billing, TTL on `ttl` attr, GSIs per §3.4) — attribute-definitions for PK/SK/GSI keys only.
- Attachment bucket (`BlockPublicAccess` default, CORS per §4.4, `LifecycleRule` optional; no public access.)
- Icons cache: same bucket, `/icons/` prefix (or separate bucket; same is enough — Lambda writes them, CloudFront never reads S3 for icons, only API responses).
- SSM Parameters for any secrets.
- Exports table name/bucket name/arns for Stack 2.

**Stack 2 — `VaultService`** (deploys with every code change):
- `NodejsFunction` (`aws-lambda-nodejs`, Node 22, esbuild minify, 256 MB, env: table + bucket + region; role scoped to the two resources).
- `HttpApi` (`aws-apigatewayv2`), `$default` catch-all route, payload format 2.0, Lambda integration; optional `HttpApiStage` logging.
- WAF web ACL attach to the stage (optional, off by default).
- `Bucket` web-vault static + `BucketDeployment` (`aws-s3-deployment`, `Source.asset("./web-vault/dist")`).
- `Distribution` with the two origins + behaviors of §1.1; `OriginAccessControl` (OAC) for the S3 origin; ACM cert (us-east-1) + Route53 `ARecord` alias.
- Web vault `config.json` overlay: BucketDeployment `Source.jsonData`-style merge or a tiny build step generating `config.json` with `{"urls":{"server":"<distribution domain>"}}` alongside the dist.

**Web vault artifact — flagged build-pipeline concern.** The OSS web vault build requires building the full `bitwarden/clients` Angular monorepo (heavy toolchain, minutes of build, frequent breaking moves between releases). Options:

1. **Vendored prebuilt dist pinned to a web-vault release** (e.g. the `vaultwarden/web-vault` release artifacts — published zips built from official bitwarden/clients releases) → `BucketDeployment` directly. **Recommended.** Note: third-party build artifact = supply-chain consideration; pin exact version + checksum in the build script, keep provenance visible.
2. Build `bitwarden/clients` in CI (GitHub Actions) from a pinned tag → more trustworthy, much slower/fragile. Only if option 1's provenance is rejected by the user.

Either is external to the CDK diff loop; `cdk deploy` consumes the dist directory verbatim.

**Deploy flow:** `web-vault/` fetch-or-build step → `cdk deploy VaultData VaultService`. No containers anywhere; no VPC needed (no RDS/EFS); Lambda runs in the default internet path for icon fetching.

---

## 8. Sources

**Vaultwarden (server behavior, the compatibility contract):**
- Migrations/entity inventory: https://github.com/dani-garcia/vaultwarden/tree/main/migrations
- Attachment upload/download handlers: `src/api/core/ciphers.rs` (post_attachment_v2, post_attachment_v2_data, save_attachment, get_attachment)
- Attachment model/presigning: `src/db/models/attachment.rs` (get_url → presign_read)
- Storage layer: `src/storage.rs` (OpenDAL; S3 only as server-side store, never client-direct)
- Token/identity: `src/api/identity.rs`, `src/auth.rs` (connect/token, authenticated_response, refresh_tokens, Bearer auth)
- All via https://github.com/dani-garcia/vaultwarden (main branch)

**Bitwarden clients (what the clients actually send):**
- Upload flow: `libs/common/src/vault/services/file-upload/cipher-file-upload.service.ts`; `libs/common/src/platform/services/file-upload/file-upload.service.ts`, `azure-file-upload.service.ts` (PUT, `x-ms-*`, 201 assertion), `bitwarden-file-upload.service.ts` (multipart FormData POST)
- `FileUploadType` enum + `AttachmentUploadDataResponse`: `libs/common/src/platform/enums`; `libs/common/src/vault/models/response/attachment-upload-data.response.ts`
- Web vault config/same-origin: https://github.com/bitwarden/clients (apps/web)
- Via https://github.com/bitwarden/clients (main branch)

**AWS:**
- Lambda quotas (6 MB sync payload, runtimes, memory/timeout): https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
- HTTP API quotas (integration timeout 30 s, payload 10 MB): https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html
- HTTP API → Lambda proxy (payload format 2.0): https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
- WAF on HTTP API: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-waf.html
- DynamoDB on-demand: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html
- DynamoDB TTL: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html
- Single-table/noSQL design guidance: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html, https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-modeling-nosql.html
- Presigned URLs: https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingPresignedURL.html
- CDK v2 docs: https://docs.aws.amazon.com/cdk/v2/guide/home.html; BucketDeployment: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3_deployment.BucketDeployment.html

---

## 9. Open questions / deferred

- **Attachment ceiling ~4.5 MB** on the Direct flow (Lambda sync limit) — the only hard regression vs. Vaultwarden; Azure-style presigned PUT + Lambda@Edge 200→201 rewrite is the escape hatch if large files are required. DECIDED: accept + document.
- Argon2id login: WASM dep needed; default installs land on PBKDF2. DEFERRED.
- Web vault artifact provenance (prebuilt zip vs. building bitwarden/clients in CI). DECIDED: pin + checksum a prebuilt release; revisit if provenance rejected.
- Org/collection support (GSI/spreadsheet in §3.1 phase 2) — single-table still holds; real multi-user sharing is the point where the schema earns scrutiny. DEFERRED.
- Email sending (verification, new-device alerts): SMTP creds in SSM; out of scope for first cut.