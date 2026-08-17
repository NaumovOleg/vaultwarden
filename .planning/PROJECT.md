# PROJECT.md — Custom Bitwarden-Compatible Server on AWS Lambda

## Vision

A fully custom, Bitwarden-compatible password manager backend written from
scratch in TypeScript, running natively on AWS Lambda + DynamoDB + S3 — no
containers, no EFS, no SQLite. Real Bitwarden clients (Web Vault, mobile apps,
desktop apps, browser extension) connect to it and work as if it were
Bitwarden or Vaultwarden.

## Core Value

"Users can install any Bitwarden client, point it at our API, and manage their
vaults, orgs, collections, and attachments — without Bitwarden's cloud, and
without the operational fragility of running Vaultwarden in containers."

## Why This Exists

The current repo runs the upstream Vaultwarden binary as a Docker-image Lambda
with SQLite on EFS. That setup produces constant operational failures
(database locks, EFS staleness, container cold path issues). Instead of
fighting it, replace it: a serverless-native implementation has no database
file, no locks, no container — each request is an independent Lambda
invocation.

## Non-Negotiable Constraints

1. **Everything runs on Lambda** — API Gateway (HTTP API) → Lambda → DynamoDB.
   No EC2, no Fargate, no ECS, no containers anywhere.
2. **Real Bitwarden clients must work** — Web Vault OSS, iOS/Android apps,
   desktop apps, browser extension. Compatible API surface, not "inspired by".
3. **Multi-user with organizations** — orgs, organizations, collections,
   member management, org crypto (RSA + shared keys), invites.
4. **Attachments** — files on S3, metadata in DynamoDB, Azure-Blob-style
   upload protocol the clients use.
5. **No email** — no SMTP, no SES, no verification emails. (Token-based
   fallbacks where clients require something.)
6. **Existing code is the baseline to replace** — CDK stack survives as the
   deploy mechanism; Docker/EFS/SQLite parts are deleted.

## Tech Stack (decided)

- Backend: TypeScript/Node.js on Lambda (single handler, API Gateway HTTP API)
- Data: DynamoDB (single table, org/user items, ciphers, folders, collections)
- Files: S3 with presigned URLs
- Frontend: Bitwarden Web Vault OSS static build on S3 + CloudFront
- Infra: AWS CDK v2 (same repo, rewritten stack)
- Crypto: node crypto + argon2 — must match Bitwarden protocol exactly
  (PBKDF2-SHA256 / Argon2id KDF, AES-256-CBC + HMAC-SHA256, RSA-2048 org keys)

## Out of Scope (explicitly)

- Email delivery / verification
- SignalR notifications hub (clients fall back to polling — verify this)
- Emergency access (stretch, decide in roadmap)
- Sends (decide in roadmap)
- Hardware key / FIDO2 2FA (secondary factor decisions later; TOTP + recovery codes minimum if 2FA at all)
- Bitwarden cloud features: families plans, premium nags

## Constraints from Motivation

- Must be deployable by one person at near-zero cost (existing budget posture)
- Must not require NAT gateway / VPC (DynamoDB + API Gateway are all
  serverless-managed)
- The API surface is defined by upstream Vaultwarden (Rust, OSS) — that source
  is the compatibility reference