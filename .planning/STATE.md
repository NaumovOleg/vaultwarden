# STATE.md — Project Memory

## Current Position
- **Phase:** 1 (Serverless Skeleton) — planned, not executed
- **Next:** `/gsd:execute-phase 1` — 3 plans, 3 waves (01 infra → 02 endpoints → 03 webvault+deploy)
- **Completed:** PROJECT.md, config, research (4 reports), FEATURES.md, REQUIREMENTS.md, ROADMAP.md, phase-1 plans (3)

## Project Facts
- Full custom Bitwarden-compatible server: Node 22 Lambda + DynamoDB + S3, CDK v2 rewrite
- Clients: Web Vault OSS (hosted), mobile, desktop, browser extension — full multi-user + orgs + attachments
- No email, no containers, no EFS. Existing docker/EFS/SQLite infra = delete
- Reference impl: vaultwarden (Rust) — API surface + storage semantics; research in `.planning/research/`

## Key Technical Decisions (locked)
1. Single CloudFront origin: static S3 default + `/api|identity|icons|alive` → API GW → single Node 22 Lambda, hand-rolled router
2. Single DynamoDB table on-demand; opaque tokens (SESS#{token}) + securityStamp; no JWT
3. Attachments: Direct multipart through Lambda → S3 (4.5 MB cap); presigned GET download
4. Crypto: server relays EncStrings; constant-time compare; kdfConfig+legacy dual emit; Argon2id salt=SHA256(email) — hash-wasm dep needed
5. Web Vault artifact: pinned prebuilt zip (revisit: CI build)
6. Backup: DynamoDB PITR + S3 versioning (replaces nightly EFS backup)
7. Invites without email: accept-token surfaced in UI (Phase 5)

## Open Items
- [ ] Web vault artifact source decision (phase 1)
- [ ] Attachment 6MB→larger escape hatch (phase 4, documented not built)
- [ ] Passwordless/passkey endpoint drift (v2, monitor)
- [ ] Admin panel (out of scope)

## Context Budget Notes
- Planning consumed ~35% at end of new-project. Next session: plan phase 1, then execute or stop.