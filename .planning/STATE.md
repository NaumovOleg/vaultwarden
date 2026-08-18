# STATE.md — Project Memory

## Current Position
- **Phase:** 2 (Identity & Auth) — **plans 01-03 code-complete** (register/prelogin, connect/token suite, devices + middleware + e2e harness; 72 tests green). **Task 3 (deploy + web-vault login checkpoint) is OWNER-RUN** — see `.planning/phases/02-identity-auth/03-SUMMARY.md` "DEPLOY HANDOFF".
- **Next:** Owner: `npm run webvault && npx cdk deploy --context vaultwarden:signupsAllowed=true`, `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online`, redeploy signups=false, human web-vault login check. Then Phase 3 (cipher surface + /api/sync).
- **Completed:** PROJECT.md, config, research (4 reports), FEATURES.md, REQUIREMENTS.md, ROADMAP.md, phase-1 (3 plans executed, code-complete), phase-2 plans (3), phase-2 plans 01-03 (executed, 72 tests green)

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
- Phase 1 deploy deferred by owner decision ("write the whole project, then I deploy"). Same policy applies to every later phase's deploy task.
- Phase 2 planned (3 plans); key execution-time verification required: exact `authenticated_response`/`twofactor_auth` field shapes from vaultwarden main `src/api/identity.rs`, and `password_iterations` default from `src/config.rs`.