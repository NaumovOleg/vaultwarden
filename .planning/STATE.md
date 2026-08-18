# STATE.md — Project Memory

## Current Position
- **Phase:** 3 (Vault Core) — **code-complete** (plans 01-03: profile/keys/sync, cipher CRUD/trash, folders/import/account mgmt; 100 tests green). **Deploy + human web-vault check is OWNER-RUN** — see `.planning/phases/03-vault-core/03-SUMMARY.md` "Deferred / next".
- **Next:** Phase 4 (Attachments & Sends) — plans 01-02 written at `.planning/phases/04-attachments-sends/`, execution in progress.
- **Next:** Owner: `npm run webvault && npx cdk deploy --context vaultwarden:signupsAllowed=true`, `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online`, `bash scripts/e2e-vault.sh https://vaultwarden.free-bert.online`, redeploy signups=false, human web-vault personal-vault check. Then Phase 4 (attachments).
- **Completed:** PROJECT.md, config, research (4 reports), FEATURES.md, REQUIREMENTS.md, ROADMAP.md, phase-1 (3 plans executed), phase-2 plans 01-03 (72 tests green), phase-3 plans 01-03 (100 tests green)

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
- [ ] Attachment 6MB→larger escape hatch (phase 4, documented not built)
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
- Phase 1 deploy deferred by owner decision ("write the whole project, then I deploy"). Same policy applies to every later phase's deploy task.
- Phase 2 planned (3 plans); key execution-time verification required: exact `authenticated_response`/`twofactor_auth` field shapes from vaultwarden main `src/api/identity.rs`, and `password_iterations` default from `src/config.rs`.