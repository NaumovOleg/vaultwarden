# Vaultwarden on AWS Serverless

## What this is

A custom, Bitwarden-compatible password server, reimplemented from scratch as a
serverless AWS application: Node 22 Lambda + DynamoDB + S3 + API Gateway HTTP
API + CloudFront. No containers, no EFS, no SQLite, no VPC.

- API surface and storage semantics follow [Vaultwarden](https://github.com/dani-garcia/vaultwarden) (the reference implementation).
- Clients: the hosted Bitwarden Web Vault (prebuilt artifact), plus official mobile/desktop/extension clients.
- Scope: full multi-user support + organizations + attachments, built phase by phase — see `.planning/ROADMAP.md`.
- Design and research notes: `.planning/` (PROJECT.md, research/, phases/).

```
                ┌────────────── CloudFront ──────────────┐
                │  / (web vault)        /api /identity…  │
                ▼                                        ▼
        S3 static bucket (OAC)              HTTP API ($default)
                                                     │
                                                     ▼
                                        Node 22 Lambda (hand-rolled router)
                                           │                   │
                                           ▼                   ▼
                                  DynamoDB (single table)  S3 attachments/icons
```

## Status

All 8 phases are **code-complete** (149 jest tests green, tsc clean, offline
synth green): serverless skeleton, identity & auth, vault core (ciphers,
folders, import, account lifecycle), attachments & sends, organizations &
collections, 2FA (TOTP + email-code without transport), hardening (icons,
domains, hibp stub, alarms, backup runbook), emergency access. A live deploy
plus human checks on the real clients is the last checkbox.

**Works today:** full Bitwarden-compatible API — register/prelogin/token
(4 grants), sync, ciphers + trash/restore/purge/import, folders, attachments
(v2 direct multipart), sends (text+file+anonymous access), organizations
(invite/accept/confirm, collections, sharing, policies, roles), 2FA
(TOTP + recovery codes + remember-device + email-code), emergency access
(trust/access/takeover), devices, account management (password/kdf/
security-stamp/verify/delete/profile), icons, settings/domains, favicon
service. Clients: hosted Web Vault (pinned artifact), mobile, desktop,
browser extension.

**Deferred/documented:** email transport of any kind (codes are surfaced in
responses), SSO, passkeys/WebAuthn, Duo/Yubikey, org event log, billing —
see `.planning/REQUIREMENTS.md` (v2 section).

## Prerequisites

- Node 24+, npm
- AWS credentials with deploy rights (`DEFAULT_ACCOUNT` / `DEFAULT_REGION` via `.env`; falls back to CDK defaults / `eu-west-1`)
- **No container runtime** (no Docker, no colima). **No Python venv** (the backup Lambda is gone).

## Deploy

```bash
# once: the static bucket lives outside the stack (see below)
aws s3 mb s3://vaultwarden-static-602101700579 --region eu-west-1

npm ci
npm run webvault   # pins + verifies + extracts the Web Vault into static/
npx cdk deploy
aws s3 sync static s3://vaultwarden-static-602101700579   # web vault + accept pages
```

The static bucket is deliberately **external to the stack** (imported by
`vaultwarden:staticBucketName`): stack deploys/destroys never touch it, and the
~90MB/120-file web vault is uploaded locally with `aws s3 sync` (the CDK
BucketDeployment custom-resource Lambda times out at 15 min on that payload).
Re-run the sync after bumping the pinned webvault version, then invalidate:

```bash
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths '/*'
```

`DistributionId` and `CdnDomainName` are printed in the deploy Outputs.

Context keys in `cdk.json`:

| Key | Meaning | Default |
| --- | --- | --- |
| `vaultwarden:domain` | Public URL, e.g. `https://vault.example.com` | `https://localhost` |
| `vaultwarden:certificateArn` | ACM cert (us-east-1) for the domain | none (cloudfront.net name) |
| `vaultwarden:signupsAllowed` | `"true"` opens registration during bootstrap; keep `"false"` in steady state | `false` |
| `vaultwarden:alertEmail` | Address for the AWS Budgets cost alert ($1/month threshold). Blank = no alert | `""` |

The deploy output includes the CloudFront URL. With `vaultwarden:domain` +
`vaultwarden:certificateArn` set, that domain is used directly.

## Verification

```bash
URL=https://<your-cloudfront-or-custom-domain>
curl -s -o /dev/null -w "%{http_code}\n" $URL/            # 200
curl -s $URL/alive                                        # 200, empty
curl -s $URL/now                                          # ISO-8601 UTC
curl -s $URL/api/version                                  # version string
curl -s $URL/api/config                                   # JSON with environment.featureFlags
curl -s -X POST $URL/identity/connect/token               # 404 Bitwarden envelope, not a CF error
```

Then open `$URL/` in a browser — the Bitwarden Web Vault login page must render.

Full harnesses (each step prints PASS/FAIL, exits non-zero on the first
failure):

```bash
bash scripts/e2e-auth.sh $URL            # register → login → refresh → 2FA challenge flow
bash scripts/e2e-vault.sh $URL           # 16 steps: vault CRUD, attachments, sends, orgs, 2FA, emergency access
```

## Organizations (no-email invites)

Organizations use the no-email invite flow: the invite endpoint returns one
`accessToken` per invitee instead of sending mail. Surface the accept link
yourself, e.g. from the admin's member list after `POST
/api/organizations/{id}/users/invite`:

```
https://<your-domain>/accept.html?token=<accessToken>&orgUserId=<memberId>
```

`accept.html` (served from the static bucket) collects email, name and master
password, hashes the password client-side (SHA-256 → base64) and registers the
account bound to the invitation. After the first invite, register a regular
account in the Web Vault — sign-ups must be open at that point
(`vaultwarden:signupsAllowed: "true"`), then flip the flag back.

## Emergency access (no-email invites)

Same surfacing trick as orgs: `POST /api/emergency-access/invite` returns the
item id and an accept token in the response. The grantee registers through
`ea-accept.html`:

```
https://<your-domain>/ea-accept.html?id=<emergencyAccessId>&token=<emergencyAccessToken>
```

The full flow in the web vault (Settings → Emergency Access): invite → grantee
registers via the surfaced link → grantor confirms (seals the vault key to the
grantee's public key) → grantee initiates after the wait time → grantor
approves → grantee views the vault or takes it over (issue a new master
password, which resets the grantor's).

## Architecture in one screen

| Piece | What it is |
| --- | --- |
| Node 22 Lambda | The whole API — hand-rolled router, no framework |
| DynamoDB `VaultTable` | Single-table design (`pk`/`sk`), on-demand billing, PITR on, **RETAIN** — a stack destroy never deletes your vault |
| S3 `static-webvault` | Web Vault build, served through CloudFront OAC, private |
| S3 `attachments` / `icons` | Attachment data (versioned) and icon cache |
| API Gateway HTTP API | `$default` catch-all → Lambda; no CORS needed (single origin) |
| CloudFront | `/` → S3, `/api/*` `/identity/*` `/icons/*` `/alive` `/now` → API (uncached) |
| CostGuard | AWS Budgets alert at $1/month forecast, gated on `vaultwarden:alertEmail` |

## Backup / restore

- DynamoDB: **PITR is on** for `VaultTable` (35 days), and the table is
  `RETAIN` — the vault survives stack deletion, and point-in-time restore
  covers data loss.
- S3: versioning on `attachments` (every version recoverable).
- **Full runbook: [`docs/ops/backup-restore.md`](docs/ops/backup-restore.md)** —
  PITR restore → repoint `VAULT_TABLE` → attachments version recovery → smoke
  checklist.

## Monitoring

- **Alarms**: Lambda errors and API 5xx page `vaultwarden:alertEmail` via SNS
  within one 5-minute period.
- **Budget**: `CostGuard` alerts at $1/month forecast — set
  `vaultwarden:alertEmail` in `cdk.json` or neither budget nor alarms are
  created (deploy-time warning).
- **Logs**: Lambda logs to CloudWatch (`/aws/lambda/<name>`); 2FA email codes
  and start-up lines are visible there.

## Cost

| Resource | Steady state |
| --- | --- |
| DynamoDB on-demand (solo use) | ~$0.00 |
| S3 (attachments, icons, web vault) | cents |
| Lambda | free tier, then ~$0 |
| CloudFront | free tier, then ~$0 |
| **Total** | **≈ $0** for a solo vault |

`CostGuard` alerts at $1/month forecast — set `vaultwarden:alertEmail` or you
won't be told.

## Development

```bash
npm test        # jest — stack assertions + router/endpoints/handler/dev-server
npm run dev     # local HTTP server wrapping the real handler (port 3000)
npm run synth   # offline synthesis, no network lookups needed
```

`npm run dev` uses an in-memory store by default; set `VAULT_TABLE=<name>` to
target a real DynamoDB dev table (no emulators). Static pages
(`accept.html`, `ea-accept.html`, the web vault) are S3-only and don't exist
on the dev server — test the API with curl, the pages against a deploy.

Historical pre-serverless designs live in `docs/superpowers/` (kept as
record, not referenced).