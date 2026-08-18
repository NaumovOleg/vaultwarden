# ROADMAP.md — Custom Bitwarden-Compatible Server on Lambda

Mapped from REQUIREMENTS.md. Each phase ends with a verifiable state; phases are ordered so real clients start working as early as possible.

## Phase 1 — Serverless Skeleton (INFRA)
- Replace infra: delete docker/, EFS/backup-SQLite constructs; new stack: CloudFront + S3 (static, attachments, icons) + API Gateway HTTP API + single Node 22 Lambda + DynamoDB single table + Parameter-free env wiring
- Lambda skeleton: event→handler mapping, ~60-line path router, error envelope (Bitwarden `{Message, ModelState, ValidationErrors}`), request-id logging
- `/alive`, `/now`, `/api/version`, `/api/config` boot endpoints
- Web Vault OSS static build deployed (decision INFRA-05: start pinned prebuilt zip, CI build later)
- Tests: jest unit for router + CDK snapshot; deploy script
- **Success criteria:** `cdk deploy` → CloudFront serves web vault; `/alive` 200; zero containers; vaultwarden Docker bits gone from repo; `npm test` green

## Phase 2 — Identity & Auth (AUTH all)
- Register, prelogin (both shapes, kdfConfig+legacy), connect/token (password+refresh grants, all client_ids, byte-perfect response, 200-with-error for 2FA), two-factor grant, logout, devices, security-stamp enforcement, constant-time hash compare, rate limiting
- Sessions: opaque tokens in DynamoDB (SESS#{token}), rotation on refresh
- **Success criteria:** curl + @bitwarden/sdk script: register → prelogin (both shapes) → token → refresh → logout; wrong password → `400 invalid_grant`; **Web Vault login page accepts credentials** and reaches sync-required screen

## Phase 3 — Vault Core (ACCT, VAULT-01..06, 10)
- /api/profile, /api/accounts/keys, sync (full shape incl. userDecryption), ciphers CRUD + trash/restore/purge/ids, folders CRUD, import/move/share, account kdf/password/delete
- Canonical serializers (pitfall 4: strict types, no folded fields)
- **Success criteria:** SDK E2E round-trip all cipher types with real EncStrings; **Web Vault fully usable** (create account → login → add/edit/delete logins, notes, cards, identities, folders, trash, import). Mobile/desktop/extension connect and sync (validation via SDK TS + real apps at user's hands)

## Phase 4 — Attachments & Sends (VAULT-07..09, MISC-04)
- Attachment v2 Direct multipart → S3 (4.5 MB ceiling), legacy v1, presigned GET download, cleanup cascade, fileUploadType flags
- Sends: text + file sends CRUD (file reuses multipart path)
- **Success criteria:** SDK/curl multipart upload → download → byte-identical; web vault attach/detach works in UI; sends visible in clients; delete-cipher removes S3 objects

## Phase 5 — Organizations & Collections (ORG all)
- Org create/keys, collections CRUD, members invite/accept/confirm/reinvite/remove, roles, users API, orgAbility in sync, share-to-collection, org policies storage, reset-password (orgKeys) flow
- Invite UX without email: ORG-07 accept-token surfaced in UI (static accept page)
- **Success criteria:** web vault: create org → invite 2nd account → accept via surfaced token → confirm → share cipher to collection → 2nd user syncs and sees shared item; owner+admin roles behave

## Phase 6 — 2FA & Security (TFA all)
- TOTP enable/disable (authenticator), recovery codes, 2FA login + remember-device, disable-with-key-block, KDF rehash on change (600k floor honored), security-stamp cascade revocation
- **Success criteria:** SDK: enable TOTP → brute-check 2FA-required 200-shape → complete via two-factor grant → recovery code login; disabled email-2FA degrades gracefully in web vault

## Phase 7 — Hardening & Polish (MISC-01..03,06 + INFRA-06..08)
- Icons service, domains endpoint, hibp stub, rate-limit tuning, error-format audit against pitfall list, CloudWatch alarms + budget (existing pattern), DynamoDB PITR + restore runbook, E2E test suite (SDK) wired into CI or deploy hook
- **Success criteria:** full pitfall checklist passes; alarm+backup verified; full SDK E2E suite green from clean account

## Phase 8 — Emergency Access & Extras (MISC-05, v2 leftovers that fit) ✅ code-complete
- Emergency access basic flow (trust/accept/request/grant/takeover) — shipped plan 08-01: surfaced tokens, static ea-accept.html, e2e step 16
- Avatar stubs, remaining account misc — documented skips (web vault renders initials, `PUT /api/accounts/avatar` skipped)
- Revisit v2 list; document decisions — done: REQUIREMENTS.md reconciled (email 2FA shipped w/o transport, EA+domains+hibp moved out of v2, events + enforcement remain v2)
- **Success criteria:** emergency flow works via surfaced tokens ✅ (curl/e2e); final compat regression on all 4 clients — **OWNER-RUN after deploy**

## Cross-cutting (every phase)
- Bitwarden error envelope everywhere; never 404 identity routes (pitfall 1); kdfConfig+legacy duality (pitfall 2); verbatim hash compare (pitfall 5)
- Each plan: unit-testable; leave `.planning/phases/XX/` artifacts (PLAN/SUMMARY/VERIFICATION/UAT)

## Dependencies
P1 → P2 → P3 → P4 (attachments reuse cipher infra) ; P5 after P3 (org crypto relay needs vault auth); P6 independent of P5 (can shift); P7 after P2+icon fetch; P8 last.