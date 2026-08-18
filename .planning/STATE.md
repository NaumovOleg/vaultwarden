# STATE.md — Project Memory

## Current Position
- **Phase:** 7 (Hardening & Polish) — **code-complete** (plan 01: icons service + settings/domains + hibp stub; plan 02: error alarms + restore runbook + README; 144 tests green). **Deploy + human checks OWNER-RUN** — see `.planning/phases/07-hardening/02-SUMMARY.md` "Owner handoff".
- **Next:** Phase 8 (Emergency Access & Extras: trust/accept/request/grant/takeover via surfaced tokens, avatar stubs, final compat regression) — OR owner deploy handoff for phases 6+7.
- **Completed:** PROJECT.md, config, research (4 reports), FEATURES.md, REQUIREMENTS.md, ROADMAP.md, phases 1-7 (phase 6: 133 tests, phase 7: 144 tests green)

## Project Facts
- Full custom Bitwarden-compatible server: Node 22 Lambda + DynamoDB + S3, CDK v2 rewrite
- Clients: Web Vault OSS (hosted, pinned v2026.6.4 artifact), mobile, desktop, browser extension — full multi-user + orgs + attachments
- No email, no containers, no EFS. Existing docker/EFS/SQLite infra = deleted
- Reference impl: vaultwarden (Rust) — API surface + storage semantics; research in `.planning/research/`

## Key Technical Decisions (locked)
1. Single CloudFront origin setup: static S3 default (OAC) + `/api|identity|icons|alive|now` → API GW → single Node 22 Lambda, hand-rolled router
2. Single DynamoDB table on-demand; opaque tokens (SESS#{token}) + securityStamp; no JWT
3. Attachments: Direct multipart through Lambda → S3 (4.5 MB cap); presigned GET download
4. Crypto: server relays EncStrings; constant-time compare; kdfConfig+legacy dual emit; Argon2id salt=SHA256(email) — hash-wasm dep needed
5. Web Vault artifact: pinned prebuilt zip (v2026.6.4, sha256-verified) — revisit: CI build
6. Backup: DynamoDB PITR (on) + S3 versioning (attachments); restore runbook is a phase 7 artifact
7. Invites without email: accept-token surfaced in UI (Phase 5)

## Open Items
- [ ] **Phase-1 live deploy** — owner runs: `npm run webvault && npx cdk deploy`, then curl smoke list (README "Verification") + browser check of the login page
- [ ] Web vault artifact source decision (CI build vs pinned zip) — revisit later
- [ ] Attachment 6MB→larger escape hatch (phase 4, documented not built — 4.5 MB direct ceiling, presigned-PUT is the upgrade)
- [ ] Passwordless/passkey endpoint drift (v2, monitor)
- [ ] Admin panel (out of scope)

## Context Budget Notes
- Phase 1 fully executed at code level: 3 plans, 3 commits, 31 tests green, offline synth green.
- Phase 2 plan 01 executed: commit 7b1cee5, 50 tests green (6 suites), tsc + synth green. GSI1, Store (Dynamo + Memory), crypto (PBKDF2 wrap 600k), register ×2 paths, prelogin ×3 paths, body parsing, VAULT_TABLE env + write grant all live.
- Phase 2 plan 02 executed: commit 36a83e8, 63 tests green (7 suites). connect/token password+refresh grants, pair rotation, endsession, 2FA 200-envelope shape, per-IP rate limit, TTL on table.
- Phase 2 plan 03 executed: commit (see log), 72 tests green (8 suites). Bearer middleware (verifyAccessToken + stamp revocation), devices endpoints (list/identifier/token/clear-token), e2e-auth.sh harness. Task 3 (live deploy + web vault login) deferred to owner per standing policy.
- Phase 3 plan 01 executed: commit (see log), 81 tests green (9 suites). accounts.ts profile/revision-date/keys/sync (+partial), UserItem avatarColor/masterKey*/revisionDate*/revisionDateMs, CipherItem/FolderItem types + list methods, RouteContext.query from rawQueryString.
- Phase 3 plan 02 executed: commit (see log), 89 tests green (10 suites). ciphers.ts canonical serializer + full CRUD/trash/move/purge/bulk surface (24 routes), sync.ciphers filled, MemoryStore cipher/folder upsert fix, DDB begins_with query fix. Archive skipped (vaultwarden maps archive → soft delete).
- Phase 3 plan 03 executed: commit (see log), 100 tests green (11 suites). folders.ts CRUD + orphan semantics (pinned vs VW source), POST /api/ciphers/import, account mgmt (password/kdf/security-stamp/verify-password/delete/profile), store.deleteUser, e2e-vault.sh + e2e:vault script. stack.test.ts CDK_OUTDIR pinned (was leaking ~170MB/run → 180GB ENOSPC). Deploy + web-vault check deferred to owner per standing policy.
- Phase 4 plan 01 executed: 107 tests green (12 suites). src/objects.ts ObjectStore (S3 + Memory, presigned GET 5min, deletePrefix paginated), attachment v2/legacy/upload/get/delete + 401/404/413, cipherPurge + deleteAccount cascade S3 prefixes, bucket CORS + ATTACHMENTS_BUCKET env, byte-exact multipart via ctx.bodyBytes.
- Phase 4 plan 02 executed: 115 tests green (12 suites). sends.ts CRUD + file/v2 + anonymous access + 302 download, SendItem + GSI1 SENDACCESS lookup, sync.sends, deleteAccount/deleteSend cascade send objects, e2e-vault.sh steps 12-13. AccessId = 10-hex handle; password client-hashed SHA-256 b64 stored as hash. Deploy + web-vault check deferred to owner per standing policy.
- Phase 5 plan 01 executed: commit 8437101, 120 tests green (13 suites). Org/collection storage + endpoints, sync profile.organizations + collections; member id = pk suffix (user id once bound, invite uuid before).
- Phase 5 plan 02 executed: commit 5351d4a, 124 tests green. members.ts (invite/reinvite/accept/roles/revoke-restore/bulk/public-keys, INVITE# GSI for tokens), policies.ts (ORG#{orgId}#POLICY#{type} + sync.policies), register orgInviteToken binding validated before user creation.
- Phase 5 plan 03 executed: commits 3a86e03 + 023be83, 126 tests green. share/admin/collections(_v2)/organization-details endpoints, listCiphersForUser union read model, ORGCOLL link rows, org-delete cipher+attachment cascade, static accept.html + BucketDeployment static/ source, e2e-vault.sh step 14, README no-email invite section. Phase-5 deploy deferred to owner per standing policy.
- Phase 6 plan 01 executed: commits 02c2d5c + f74a821, 130 tests green. crypto.ts TOTP (RFC 6238 vector 287082@T=59 verified), base32, recovery codes as SHA-256 hashes (get-recover returns hashes — vaultwarden-compatible, login accepts code OR hash), two-factor.ts get-authenticator (pending key)/authenticator/DELETE/disable/get-recover, GET /api/two-factor provider rows, login challenge with per-provider TwoFactorProviders2, single-use TwoFactorToken, remember-device (twoFactorRemembered flag, twofactorremember=1, legacy Auth-2FA/-Remember headers).
- Phase 6 plan 02 executed: commit 996e408, 132 tests green. Email provider: get-email/send-email (setup code; no transport — code echoed in body + logged, ponytail: SES later)/send-email-login/email enable, masked address storage+display, multi-provider challenge [0,1], disable(type) per provider, recovery codes regenerated only when none exist, cleared on disable.
- Phase 6 plan 03 executed: commit (see log), 133 tests green. clearRememberedDevices on all three stamp rotations (password/kdf/security-stamp) — remembered-device 2FA bypass dies with sessions; e2e-vault.sh step 15 (enable TOTP → challenge → TOTP login → disable); 03-SUMMARY.md. Phase-6 deploy deferred to owner per standing policy.
- Phase 7 plan 01 executed: commits 70d3c2e + 63f77b6, 142 tests green. icons.ts (normalized host → cached S3 miss → icons.bitwarden.net fetch → 24h cache; empty-object negative markers; ICONS_BUCKET env + grants + /icons route), ObjectStore.getObject added to both stores, RouteContext.icons, settings/domains GET+PUT/POST user override (UserItem.domainsOverride, 400 on garbage), hibp 404 stub.
- Phase 7 plan 02 executed: commits dbee77d + wrap, 144 tests green. CloudWatch Lambda-Errors + API-5XX alarms → SNS email (gated on vaultwarden:alertEmail, stack tests assert both gated paths), docs/ops/backup-restore.md runbook (PITR restore → repoint VAULT_TABLE → TTL re-add → attachments version recovery → smoke checklist), README Backup+Monitoring sections, 02-SUMMARY.md. SDK E2E harness intentionally not added (bash e2e scripts are the harness). Phase-7 deploy deferred to owner per standing policy.
- Phase 1 deploy deferred by owner decision ("write the whole project, then I deploy"). Same policy applies to every later phase's deploy task.
- Phase 2 planned (3 plans); key execution-time verification required: exact `authenticated_response`/`twofactor_auth` field shapes from vaultwarden main `src/api/identity.rs`, and `password_iterations` default from `src/config.rs`.