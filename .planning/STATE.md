# STATE.md — Project Memory

## Current Position
- **Phase:** 1 (Serverless Skeleton) — code complete, **deploy pending** (owner deploys; `npx cdk deploy` after `npm run webvault`)
- **Next:** after deploy smoke pass → `/gsd:plan-phase 2` (auth: accounts, tokens, ciphers, sync)
- **Completed:** PROJECT.md, config, research (4 reports), FEATURES.md, REQUIREMENTS.md, ROADMAP.md, phase-1 plans (3) + execution (3 plans; plans 01–02 fully verified, plan 03 code done, live deploy + browser checkpoint outstanding)

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
- Phase 1 deploy deferred by owner decision ("write the whole project, then I deploy").