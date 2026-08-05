# Vaultwarden on AWS Serverless — Design

**Date:** 2026-08-04
**Status:** Approved for planning
**Region:** `eu-west-1`
**IaC:** AWS CDK v2, TypeScript

## 1. Goal

Run a self-hosted Vaultwarden instance for a single personal user at the lowest
possible running cost, deployed entirely from one CDK stack.

Cost target: $0.00/month during the first 12 months, under $0.20/month afterwards.

### Non-goals

- Multi-user or organisation features
- High availability across Availability Zones
- Email delivery
- Push notifications over WebSocket

## 2. Prior art evaluated

| Project                                                                                                   | IaC                  | Status                                   | Verdict                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [darioackermann/vaultwarden-serverless](https://github.com/darioackermann/vaultwarden-serverless)         | Terraform            | Last push Sep 2023                       | Ideas only. Patches Vaultwarden sources with the `lambda-web` crate, pinning it to a 2023 build. Attaches an Elastic IP to the Lambda ENI, which is unsupported. No concurrency cap, so its documented random SQLite lock failures are self-inflicted. |
| [vvondra/bitwarden-serverless](https://github.com/vvondra/bitwarden-serverless)                           | Serverless Framework | Archived Jun 2022                        | Rejected. Not Vaultwarden — an independent Node.js reimplementation of the Bitwarden API on DynamoDB, abandoned since 2020, schema validation still a TODO.                                                                                            |
| [richardneililagan/vaultwarden-ecs-fargate](https://github.com/richardneililagan/vaultwarden-ecs-fargate) | CDK                  | Partially maintained                     | Rejected on cost. Fargate is roughly $10/month.                                                                                                                                                                                                        |
| [PR #5591 — RFC: AWS Serverless](https://github.com/dani-garcia/vaultwarden/pull/5591)                    | CDK assets           | Draft, unmerged                          | Rejected. Aurora DSQL + S3 + SES behind an `aws` feature flag. Requires maintaining a fork of an unmerged branch; DSQL lacks foreign keys and multi-statement DDL, which threatens future Vaultwarden migrations.                                      |
| [PR #5626 — OpenDAL file abstraction](https://github.com/dani-garcia/vaultwarden/pull/5626)               | —                    | **Merged 2025-05-29**, shipped in 1.35.0 | Available but not used. See §3.                                                                                                                                                                                                                        |

No existing CDK + Lambda + EFS implementation exists. This design is new.

### Why S3 cannot replace EFS here

PR #5626 routes `ATTACHMENTS_FOLDER`, `SENDS_FOLDER`, `ICON_CACHE_FOLDER` and
`RSA_KEY_FILENAME` through Apache OpenDAL, so those can live on S3 via
`DATA_FOLDER=s3://bucket/prefix`.

`DATABASE_URL`, `TMP_FOLDER` and `TEMPLATES_FOLDER` are explicitly excluded and
must remain local paths. SQLite requires a POSIX filesystem with working advisory
locks, which object storage does not provide.

A serverless deployment therefore needs either EFS (this design) or an external
database engine (PR #5591). Since the S3 path would only move a handful of
kilobytes of attachments off EFS while forcing a custom image build — the
official image is compiled with `DB=sqlite,mysql,postgresql` and no `s3` feature —
it is not worth the complexity. Everything lives on EFS.

A third option, SQLite in `/tmp` with Litestream replication to S3, is rejected
outright: Lambda freezes execution environments between invocations, so
replication can be interrupted mid-write and corrupt the vault.

## 3. Architecture

```
Internet
   │
   ▼
CloudFront distribution                    public entry point, TLS, $0
   │   Origin Access Control, SigV4-signed
   ▼
Lambda Function URL (authType: AWS_IAM)    unsigned requests → 403
   │
   ▼
Lambda: Vaultwarden container              arm64, reservedConcurrency = 10
   │   in VPC, no NAT, no outbound internet
   ▼
EFS One Zone (Bursting)                    SQLite database + all data
   ▲
   │  nightly 03:00 UTC via EventBridge
Backup Lambda (Python) ──► S3 ──► gateway VPC endpoint (free)
```

### 3.1 Networking — $0

Single VPC, `10.0.0.0/24`, `maxAzs: 1`, `natGateways: 0`.
One `PRIVATE_ISOLATED` subnet — no Internet Gateway, no outbound internet.

One AZ is deliberate: it avoids cross-AZ data charges ($0.01/GB) and enables the
EFS One Zone storage class. Availability risk is accepted and covered by the S3
backup.

A **Gateway VPC endpoint for S3** is required so the backup Lambda can reach the
bucket without a NAT Gateway. Gateway endpoints are free; interface endpoints
($7.30/month each) are not used.

CloudWatch Logs need no endpoint — the Lambda service ships logs on the
function's behalf outside the VPC network path.

The VPC-attached cold start penalty was eliminated in 2019 by Hyperplane ENIs and
is not a consideration.

### 3.2 Storage — $0.16/month

`efs.FileSystem`:

| Setting           | Value             | Reason                                                                                                     |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `oneZone`         | `true`            | $0.16/GB-month instead of $0.30                                                                            |
| `throughputMode`  | `BURSTING`        | No per-GB charge. `ELASTIC` would bill $0.03/GB read and $0.06/GB write                                    |
| `lifecyclePolicy` | not set           | Infrequent Access is cheaper per GB but bills per access; at ~50 MB the saving is zero and the risk is not |
| `performanceMode` | `GENERAL_PURPOSE` | Lowest latency                                                                                             |
| `encrypted`       | `true`            | Free                                                                                                       |
| `removalPolicy`   | `RETAIN`          | **Mandatory.** Without it `cdk destroy` deletes the vault. Retention alone is not enough to recover from a lost stack, though: see §8 |

`efs.AccessPoint`: path `/vaultwarden`, POSIX uid/gid 1000, `createAcl` 0755.

**Filesystem policy:** allow only the two Lambda execution roles, require IAM
authentication, deny `elasticfilesystem:ClientRootAccess`.

### 3.3 Application Lambda — $0

`lambda.DockerImageFunction` built from:

```dockerfile
FROM vaultwarden/server:1.35.1-alpine
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/alive \
    AWS_LWA_ASYNC_INIT=true \
    ROCKET_PORT=8080
```

The AWS Lambda Web Adapter runs as an `/opt/extensions` sidecar and proxies
Lambda invocations to the Rocket HTTP server. **Vaultwarden's source is not
modified** — unlike the `lambda-web` crate patch used by darioackermann, upgrading
is a tag change. The public ECR adapter image is multi-arch, so one tag covers
arm64.

`ROCKET_PORT` must be overridden: the official image defaults it to 80.

| Setting                        | Value                           | Reason                                                                                                                       |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `architecture`                 | `ARM_64`                        | 20% cheaper per GB-second, faster cold start                                                                                 |
| base image                     | `-alpine`                       | ~120 MB vs ~250 MB, halves ECR storage cost                                                                                  |
| `memorySize`                   | 1024 MB                         | More memory buys more vCPU, shortening cold start. Usage stays far inside the free tier                                      |
| `timeout`                      | 30 s                            | Matches CloudFront's default origin response timeout                                                                         |
| `reservedConcurrentExecutions` | **10**                          | Caps worst-case spend. See below for why not 1                                                                               |
| log group retention            | 1 week                          | Keeps CloudWatch inside the perpetual 5 GB free tier. Use an explicit `logs.LogGroup`; the `logRetention` prop is deprecated |
| filesystem                     | EFS access point at `/mnt/data` |                                                                                                                              |

**Why concurrency is 10 and not 1.** A limit of 1 would serialise database
access, but synchronous invocations above a reserved concurrency limit are not
queued — Lambda rejects them immediately with a 429. Loading the web vault makes
a browser request a dozen assets in parallel, so nearly all of them would fail
and the page would not render. The web vault is required for initial account
creation and TOTP enrolment, so this is not an acceptable trade.

Those parallel requests are static files that never touch the database. A single
user's database operations are inherently sequential. A limit of 10 absorbs the
asset burst, still bounds worst-case spend, and does not create concurrent SQLite
writers.

The SQLite-over-NFS failures documented by darioackermann are addressed instead
by disabling WAL (§3.4) and by CloudFront caching static assets so repeat loads
never reach the function (§3.5).

**IAM execution role — least privilege:** `elasticfilesystem:ClientMount` and
`ClientWrite` scoped to the specific access point ARN, plus CloudWatch Logs.
No S3, no SSM, no Secrets Manager. If the Vaultwarden process is compromised, its
credentials grant access to nothing beyond the filesystem it already serves.

### 3.4 Environment variables

| Variable                    | Value                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATA_FOLDER`               | `/mnt/data`             | EFS mount                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DATABASE_URL`              | `/mnt/data/db.sqlite3`  | SQLite file                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ENABLE_DB_WAL`             | **`false`**             | **Mandatory — deployment blocker without it.** Vaultwarden enables WAL at startup by default. SQLite's WAL mode coordinates readers through a shared-memory file mapped with `mmap`, which network filesystems do not provide, so on EFS the process aborts with `Failed to turn on WAL` and never serves a request. It must be present from the very first boot: a single startup without it writes WAL mode into the database file |
| `DOMAIN`                    | CloudFront URL (see §7) | Absolute URL generation                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SIGNUPS_ALLOWED`           | `false`                 | Set after the owner account exists                                                                                                                                                                                                                                                                                                                                                                                                   |
| `INVITATIONS_ALLOWED`       | `false`                 | Single user                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ADMIN_TOKEN`               | **unset**               | Disables `/admin` entirely — see §6                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ICON_SERVICE`              | `duckduckgo`            | Website favicons without outbound internet from the function: Vaultwarden answers `/icons/<domain>/icon.png` with an HTTP redirect instead of fetching the image itself, and the client (browser extension, app, or web vault) fetches it directly from DuckDuckGo. `duckduckgo` is one of Vaultwarden's built-in presets, whose hosts are already covered by the web vault's `img-src` Content-Security-Policy — a custom icon URL is not (dani-garcia/vaultwarden#2623) and would fail silently. DuckDuckGo over Google because it does not tie the request to an account. See §6 for the privacy trade-off this implies |
| `WEBSOCKET_ENABLED`         | `false`                 | Function URL cannot carry WebSocket                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IP_HEADER`                 | `X-Forwarded-For`       | **Required behind CloudFront.** The default `X-Real-IP` is absent, which would make every request appear to share one IP and break rate limiting                                                                                                                                                                                                                                                                                     |
| `LOGIN_RATELIMIT_SECONDS`   | `60`                    | Brute-force resistance                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LOGIN_RATELIMIT_MAX_BURST` | `5`                     |                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ROCKET_PROFILE`            | `release`               |                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SIGNUPS_VERIFY`            | `false`                 | No email available                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 3.5 CloudFront + Origin Access Control — $0

The Function URL uses `authType: AWS_IAM`. CloudFront signs every origin request
with SigV4 through an Origin Access Control. A direct request to
`https://<id>.lambda-url.eu-west-1.on.aws` returns **403 Forbidden** because it
carries no signature — the function is not publicly invocable.

```ts
const fnUrl = fn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,
});
const origin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);

const shared = {
  origin,
  originRequestPolicy:
    cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
};

new cloudfront.Distribution(this, "Cdn", {
  defaultBehavior: {
    ...shared,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  },
  additionalBehaviors: {
    // Web-vault static assets: cacheable, no credentials, never touch the DB.
    "/app/*": {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
    "/images/*": {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
    "/fonts/*": {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
    "/scripts/*": {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
    // Icon-service redirects: identical per domain, no credentials. Must be
    // cached — see the paragraph below.
    "/icons/*": {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    },
  },
});
```

`ALL_VIEWER_EXCEPT_HOST_HEADER` is mandatory: the SigV4 signature covers the
origin host, so the viewer's `Host` header must not be forwarded.

`CACHING_DISABLED` on the default behaviour is mandatory: responses from a
password vault API must never be cached at the edge. Only the five prefixes
above are cached, and they carry no credentials.

Caching static assets matters beyond latency. It keeps repeat web-vault loads
from reaching the function at all, which cuts invocation count and removes the
parallel-request burst discussed in §3.3.

`/icons/*` is not optional. `ICON_SERVICE` (§3.4) makes every icon request a
function invocation that produces a redirect; a vault list view requests many
icons in parallel, and `reservedConcurrentExecutions: 10` would turn the
surplus into 429s exactly as with the other static assets. Caching it means
only the first request per edge location per domain ever reaches the
function — the redirect itself never changes, so there is nothing lost by
serving it from cache.

No geographic restriction — the user travels.

No WAF: $5/month base plus $1/rule is over thirty times the cost of the entire
rest of the stack.

CloudFront's free tier — 1 TB egress and 10 million HTTP requests per month — is
perpetual, not a 12-month trial, and the expected load is a fraction of a percent
of it.

The CloudFront domain is also stable across function replacement, whereas a raw
Function URL changes if the function is recreated.

### 3.6 Backup — $0.024/month

A separate Python 3.12 arm64 zip Lambda, triggered by EventBridge at
`cron(0 3 * * ? *)`:

1. Mounts the same EFS access point.
2. Uses `sqlite3.Connection.backup()` to write a consistent snapshot to `/tmp`
   (512 MB, free). This is an online backup — it does not require stopping
   writers and cannot capture a torn page.
3. Gzips and uploads to S3, keyed by UTC date.

AWS Backup on EFS is **not** used: it copies the file in whatever state it finds
it, so a snapshot taken mid-write produces an unusable database.

S3 bucket: versioned, `BlockPublicAccess.BLOCK_ALL`, SSE-S3 encryption (KMS would
add cost), lifecycle expiring objects and noncurrent versions after 90 days,
`removalPolicy: RETAIN`.

**Bucket policy:** `s3:PutObject` allowed only for the backup Lambda role; deny
all other principals; deny any request where `aws:SecureTransport` is false.

The backup role gets EFS client access plus `s3:PutObject` on this bucket only.

### 3.7 Restore — $0 (never invoked, never billed)

A second Python 3.12 arm64 zip Lambda, `vaultwarden-restore`, built from the
same `lambda/backup/` asset directory as the backup function (`restore.py`
imports `validate_snapshot` from `index.py` rather than duplicating it) but with
its own function, its own role, and no EventBridge schedule — it is invoked
manually, by a human, never automatically.

This exists because a restore procedure that cannot be executed is
operationally identical to having no backup. Two things blocked it before this
Lambda existed: the isolated VPC has no SSM/SSH path to a hand-launched EC2
instance, and the EFS mount targets' security group admits only the
application and backup functions' security groups, not an ad hoc instance's.
A Lambda removes both problems at once — no shell is needed, and it gets EFS
access the same way the other two functions do, via
`fileSystem.connections.allowDefaultPortFrom`.

Two actions, selected by the invocation payload:

- `{"action": "list"}` — returns recent backup object keys, newest first, capped
  at a sane limit, so the operator can choose one without S3 console access.
- `{"action": "restore", "key": "...", "confirm": "OVERWRITE-VAULT"}` — performs
  the restore, in this order: refuse unless `confirm` matches exactly; refuse
  unless the application function's reserved concurrency is 0 (checked live via
  `lambda:GetFunctionConcurrency`, bypassable with `"force": true` for the case
  where the check itself is broken); download and decompress the snapshot to
  `/tmp`; validate the *downloaded* snapshot with the same `validate_snapshot`
  the nightly job uses, before anything at the live path is touched; copy the
  current live database aside to a timestamped name; write the new database into
  place atomically (temp file on the same EFS filesystem, then `os.replace`,
  never a direct write to the live path).

  The preservation copy is a plain file copy (`shutil.copy2`), not a
  SQLite-online-backup-API snapshot the way the nightly job's is — safe in the
  normal path specifically *because* the concurrency check just confirmed
  nothing is writing to the source file. `"force": true` bypasses that same
  check, so it also silently invalidates the assumption the plain copy relies
  on: if Vaultwarden genuinely is still writing when `force` is used, the
  preserved copy can itself be inconsistent. The live database is not at risk
  either way — `atomic_replace`'s `os.replace` swap is unconditional — but the
  preserved copy should not be trusted as an undo path for a `force`d restore.

**IAM — read access, on a separate role from the write-only backup role.** The
restore role gets EFS client access, `s3:GetObject` plus the listing action its
`list` action needs (scoped to the backup bucket only), and
`lambda:GetFunctionConcurrency` scoped to the application function's ARN only.
This is a deliberate, narrow exception to §3.6's write-only design, not a
weakening of it: the backup role itself is untouched and still cannot read or
delete snapshots. The restore role can read them, but it is a different
function, with a different role, invoked only by a human with their own AWS
credentials — never by EventBridge, never automatically. A compromise of the
backup role (the one thing actually exposed to a recurring, unattended
schedule) still yields nothing beyond write access.

## 4. Cost model

| Resource                                             | First 12 months       | Steady state      |
| ---------------------------------------------------- | --------------------- | ----------------- |
| Lambda invocations (~3k/month of 1M free, perpetual) | $0                    | $0                |
| Lambda GB-seconds (~2k of 400k free, perpetual)      | $0                    | $0                |
| Lambda Function URL                                  | $0                    | $0                |
| CloudFront (1 TB + 10M requests free, perpetual)     | $0                    | $0                |
| VPC, subnet, security groups, S3 gateway endpoint    | $0                    | $0                |
| EFS One Zone, ~50 MB used                            | $0 (5 GB free tier)   | $0.16             |
| ECR private, ~120 MB                                 | $0 (500 MB free tier) | $0.012            |
| S3, ~0.5 GB of compressed backups                    | $0 (5 GB free tier)   | $0.012            |
| CloudWatch Logs (5 GB/month free, perpetual)         | $0                    | $0                |
| Data transfer out (100 GB/month free, perpetual)     | $0                    | $0                |
| **Total**                                            | **$0.00/month**       | **≈ $0.18/month** |

For comparison: Lightsail's cheapest instance is $3.50/month; the Fargate design
is roughly $10/month; a NAT Gateway alone would be $32.85/month.

### Cost guardrails

- `reservedConcurrentExecutions: 10` bounds Lambda spend.
- An AWS Budgets alert at $1/month (two budgets are free).
- One-week log retention.

## 5. Security model

### 5.1 The endpoint is public, and cannot be otherwise

Official Bitwarden clients are ordinary HTTPS clients. They cannot sign SigV4
requests, send arbitrary headers, or present client certificates. Any endpoint
reachable by the user's phone is reachable by the internet. This is a property of
the client protocol, not a gap in this design.

CloudFront + OAC therefore does not make the service private. It relocates the
public entry point to a service that can be hardened, and closes direct
invocation of the function itself.

### 5.2 What an unauthenticated attacker can reach

| Endpoint                  | Exposure                  | Mitigation                                                |
| ------------------------- | ------------------------- | --------------------------------------------------------- |
| `/identity/connect/token` | Master password guessing  | Rate limit (5 per 60 s), strong master password, TOTP 2FA |
| `/api/accounts/register`  | Account creation          | `SIGNUPS_ALLOWED=false`                                   |
| `/admin`                  | Admin panel               | **Route does not exist** by default — `ADMIN_TOKEN` unset. Enabled only via a deliberate `--context vaultwarden:adminToken=...` redeploy; see §5.5 |
| `/alive`, `/api/config`   | Version and feature flags | Harmless                                                  |

### 5.3 What is unreachable

- The SQLite file — only via the application, backup, and restore functions'
  EFS client permission, inside the VPC.
- The backup bucket — write access is scoped to the backup role's own identity
  policy only; read access is scoped to the restore role's own identity policy
  only (§3.7). No other identity, and no unauthenticated request, can reach it.
- Direct Lambda invocation — 403 without a CloudFront SigV4 signature.
- The AWS account — no path from the Vaultwarden process.

Vault contents are encrypted client-side. Full server compromise yields
ciphertext; the key is derived from the master password and never reaches the
server.

### 5.4 Owner obligations

1. Set `SIGNUPS_ALLOWED=false` immediately after creating the owner account.
2. Use a long, unique master password. **There is no recovery.** Losing it loses
   everything, permanently.
3. Enable TOTP two-factor authentication with a separate authenticator app, and
   store the recovery code offline. See §5.5.
4. Leave `ADMIN_TOKEN` unset (`vaultwarden:adminToken` blank in `cdk.json`, the
   default). If the admin panel is ever needed, enable it with
   `--context vaultwarden:adminToken=...` for a temporary deployment and remove
   it afterwards. See §5.5.
5. Enable MFA on the AWS root account and do not use root for daily work.

### 5.5 Two-factor authentication

TOTP is the only viable second factor for this deployment. Validation is an
HMAC-SHA1 computation over a time counter, requiring neither outbound internet
nor email — the two things the isolated VPC does not provide. The Lambda clock is
NTP-synchronised by AWS, so drift is not a concern. The web vault needed to
enrol a device ships inside the official image.

WebAuthn/FIDO2 is deliberately not used: it binds the credential to an origin,
and the two-pass first deployment (§7) leaves `DOMAIN` at a placeholder until the
second pass, which would invalidate a key registered in between. TOTP is
origin-independent.

**Lockout risk.** With the admin panel disabled and no email, the usual 2FA reset
paths do not exist. Two recovery routes:

1. The **recovery code** Vaultwarden displays once at enrolment. Record it on
   paper, stored separately from the phone. This is the primary route.
2. Infrastructure ownership: `npx cdk deploy --context
   vaultwarden:adminToken=<value>` deploys with `ADMIN_TOKEN` set (see the
   `adminToken` prop on `ApplicationProps` in `lib/constructs/application.ts`,
   wired from context in `lib/vaultwarden-stack.ts`), which enables `/admin`.
   Clear the 2FA entry there, then redeploy without the context flag to disable
   `/admin` again. This is a real redeploy — building and pushing a new Docker
   image asset with a changed environment variable, then a CloudFormation
   update — not a config toggle, which is what makes disabling the admin panel
   safe by default rather than reckless: it is not available to a self-hoster
   without infrastructure access. The `vaultwarden-restore` function (§3.7) is
   also a route back to a working vault, from a snapshot taken before the
   lockout, if the admin-token route is somehow unavailable.

**Vault-stored TOTP seeds** (Bitwarden's built-in authenticator) are a separate
feature. Vaultwarden grants premium status to all users by default, so it is
available. Codes are generated client-side from an encrypted seed; the server
never sees the plaintext and is not involved in the computation, so cold starts
and the absent internet path are irrelevant.

Do **not** store the Vaultwarden account's own TOTP seed in the vault it
protects — that collapses both factors into one. Use a separate authenticator
application for it.

### 5.6 Residual risk

Sustained traffic against the endpoint raises invocation counts. This is a cost
and availability concern, not a breach: concurrency is capped at 10, CloudFront's
free tier absorbs 10 million requests per month, and the budget alert fires at $1.

## 6. Accepted limitations

- **No push notifications.** Function URLs do not support WebSocket. Clients fall
  back to polling; cross-device sync lags by a few minutes.
- **No email.** No email-based 2FA, password hints, or invitations. TOTP works.
- **Website favicons cost privacy, not money.** `ICON_SERVICE=duckduckgo`
  makes the function answer icon requests with a redirect instead of fetching
  the image itself, so it works with no outbound internet from the VPC — but
  the *client* then fetches each icon directly from DuckDuckGo, which reveals
  the domains in the vault to DuckDuckGo and to whatever network the client is
  on. `internal` mode (Vaultwarden fetches and caches icons itself, so the
  client only ever talks to this stack) would avoid that, but it is the one
  mode that needs outbound internet, i.e. a NAT Gateway at $32.85/month —
  roughly 180x this stack's entire budget — so it is rejected.
- **Attachments and Sends capped at 6 MB** by the Lambda payload limit.
- **Cold start of 2–4 seconds** on the first request after idle.
- **Single AZ.** An AZ failure makes the vault unavailable until restored from S3.

## 7. Deployment

### 7.0 Prerequisites

- Node.js 24 and npm 11 (present)
- `aws-cdk-lib` 2.263.0, `aws-cdk` CLI 2.1135.0
- AWS credentials for the target account, region `eu-west-1`
- **A container runtime is required for `cdk deploy`** — Docker Desktop, Colima,
  or Podman. `DockerImageCode.fromImageAsset` builds the image during asset
  publishing. None is currently installed on this machine.

  Unit tests are unaffected: at synthesis time CDK only hashes the asset
  directory, so `cdk synth` and the assertion tests run without a container
  runtime.

The CloudFront domain is not known before the distribution exists, and the Lambda
environment needs it for `DOMAIN`. Wiring `distribution.distributionDomainName`
into the function's environment creates a circular CloudFormation dependency
(function → URL → distribution → function).

This is resolved with a documented two-pass first deployment rather than a custom
resource, which would mutate the function outside CloudFormation and cause drift:

1. `cdk deploy` — `DOMAIN` takes its placeholder default.
2. Read `CdnDomainName` from the stack outputs.
3. Set it in `cdk.json` context as `vaultwarden:domain`.
4. `cdk deploy` again.

Subsequent deployments are single-pass. `DOMAIN` only affects absolute URL
generation and WebAuthn origin validation, so the interim state is functional for
TOTP-based setup.

## 8. Restore procedure

Performed with the `vaultwarden-restore` Lambda described in §3.7, not a
hand-launched EC2 instance — see that section for why an EC2-based procedure
cannot actually be carried out in this VPC.

**If the infrastructure itself is gone**, first: `removalPolicy: RETAIN`
(§3.2) stops AWS deleting the EFS filesystem *and* the S3 bucket when the
stack is destroyed, but neither is automatically re-adopted by a fresh
deploy. A `cdk deploy` after stack loss creates a **new**
`AWS::EFS::FileSystem` and a **new** `AWS::S3::Bucket`, each with a new
physical ID/name, not a reattachment to the orphaned resource. The bucket has
no explicit `bucketName` precisely so a clean-account deploy never collides
with a still-retained bucket from a previous stack — but that same absence of
a fixed name is what makes the new bucket unrelated to the old one.
`vaultwarden-restore`'s `BUCKET_NAME` environment variable is wired from the
bucket object in the *current* stack (`lib/constructs/backup.ts`), so
skipping the import does not error: `{"action": "list"}` against the new,
empty bucket just returns an empty list, while every real snapshot sits
untouched in the orphaned bucket with nothing to indicate that. **Both
resources need an explicit `cdk import` of their physical ID/name into the
new stack before step 1 below** — or, if the bucket import is not yet done or
wanted (e.g. to inspect what is there before deciding), use the out-of-band
fallback: `aws s3 ls`/`aws s3 cp` directly against the orphaned bucket name
(found via `aws s3 ls | grep vaultwarden`) with the operator's own
credentials, the same access pattern the pre-restore-Lambda procedure used
throughout. That fallback gets a validated snapshot file into the operator's
hands but cannot get it onto EFS by itself — `vaultwarden-restore` only ever
reads from the bucket named by its own `BUCKET_NAME`, so finishing the
restore through it still requires importing the bucket.

1. Set the application function's reserved concurrency to 0
   (`aws lambda put-function-concurrency --function-name vaultwarden
   --reserved-concurrent-executions 0`), so Vaultwarden cannot be writing to
   the database mid-restore.
2. Invoke `vaultwarden-restore` with `{"action": "list"}` to see recent backup
   keys, newest first.
3. Invoke it again with
   `{"action": "restore", "key": "<chosen key>", "confirm": "OVERWRITE-VAULT"}`.
   The function independently re-verifies step 1 is done
   (`lambda:GetFunctionConcurrency`, bypassable with `"force": true` only if
   that check itself is broken — but note that bypassing it also invalidates
   the guarantee that the preserved copy of the outgoing database is itself
   consistent; see §3.7), downloads and validates the snapshot before
   touching the live database, preserves the current database under a
   timestamped name, and swaps the new one into place atomically.
4. Restore the application function's concurrency to 10 (not 1 — see §3.3 for
   why 10 is the deployed value).

This procedure must be tested once after the first deployment, using the
`vaultwarden-restore` function exactly as it would be used in a real recovery.
An untested backup is not a backup — and unlike the EC2-based version of this
procedure this design started with, this one can actually be executed and
therefore actually tested.

## 9. Repository layout

```
bin/vaultwarden.ts               CDK app entry point
lib/vaultwarden-stack.ts         The single stack
lib/constructs/storage.ts        VPC, EFS, access point, S3 bucket
lib/constructs/application.ts    Container function, Function URL, CloudFront
lib/constructs/backup.ts         Backup function, schedule, restore function, IAM
docker/vaultwarden/Dockerfile    Official image + Lambda Web Adapter
lambda/backup/index.py           SQLite online backup to S3
lambda/backup/restore.py         Manual restore: list/validate/preserve/replace
cdk.json
package.json
```

Splitting the stack into three constructs keeps each file focused on one
responsibility with an explicit interface: `storage` exposes the VPC, access
point and bucket; `application` consumes the first two; `backup` consumes all
three.

## 10. Out of scope

- Custom domain name (would require a Route 53 hosted zone at $0.50/month)
- AWS WAF
- Multi-region or multi-AZ redundancy
- S3-backed `DATA_FOLDER` via the OpenDAL backend
- Aurora DSQL
- **Serving the web vault's static assets from S3** rather than from the
  function. This is the architecturally cleaner split — it is what PR #5591 and
  Chase Douglas both do — and would cut invocations further while removing the
  asset burst entirely. It is deferred because it requires extracting the bundled
  web vault from the image or tracking `bw_web_builds` releases separately, and
  the CloudFront caching in §3.5 already addresses the practical problem. This is
  the escape hatch if browser loads prove unreliable.
