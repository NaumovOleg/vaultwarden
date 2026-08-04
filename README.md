# Vaultwarden on AWS Serverless

## 1. What this is

This repository is a single AWS CDK (TypeScript) stack, `VaultwardenStack`, that
deploys a self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden)
password server for **one person**, in `eu-west-1`, at close to zero running
cost. The application runs as a Docker-image Lambda function behind CloudFront,
its SQLite database lives on EFS, and a nightly Lambda job backs the database up
to S3. There is no NAT gateway, no email, and no multi-user support — see
[Known limitations](#9-known-limitations) below.

The full design rationale — why Lambda instead of Fargate, why EFS instead of
S3-backed storage, the concurrency and caching decisions, and the security
model — is in the design spec:
[`docs/superpowers/specs/2026-08-04-vaultwarden-serverless-design.md`](docs/superpowers/specs/2026-08-04-vaultwarden-serverless-design.md).
This README is the operational half: how to deploy it, verify it, log into it
safely, back it up, restore it, and upgrade it.

## 2. Cost

| Resource                                             | First 12 months       | Steady state      |
| ----------------------------------------------------- | --------------------- | ------------------ |
| Lambda invocations (~3k/month of 1M free, perpetual)   | $0                    | $0                 |
| Lambda GB-seconds (~2k of 400k free, perpetual)        | $0                    | $0                 |
| Lambda Function URL                                    | $0                    | $0                 |
| CloudFront (1 TB + 10M requests free, perpetual)       | $0                    | $0                 |
| VPC, subnet, security groups, S3 gateway endpoint      | $0                    | $0                 |
| EFS One Zone, ~50 MB used                              | $0 (5 GB free tier)   | $0.16              |
| ECR private, ~120 MB                                   | $0 (500 MB free tier) | $0.012             |
| S3, ~0.5 GB of compressed backups                      | $0 (5 GB free tier)   | $0.012             |
| CloudWatch Logs (5 GB/month free, perpetual)           | $0                    | $0                 |
| Data transfer out (100 GB/month free, perpetual)       | $0                    | $0                 |
| **Total**                                              | **$0.00/month**       | **≈ $0.18/month**  |

For comparison: Lightsail's cheapest instance is $3.50/month; a Fargate
equivalent is roughly $10/month; a NAT Gateway alone would be $32.85/month.

A CDK-deployed AWS Budgets alert (`CostGuard`) fires at $1/month forecast
spend if `vaultwarden:alertEmail` is set in `cdk.json` — see
[First deployment](#4-first-deployment).

## 3. Prerequisites

- **Node.js 24** and npm (the CDK app, `bin/vaultwarden.ts`, runs via
  `ts-node`; dependencies are `aws-cdk-lib` 2.263.0 and CDK CLI 2.1135.0, both
  pinned in `package.json`).
- **AWS credentials** for the target account, with `CDK_DEFAULT_ACCOUNT` set to
  that account's number (`bin/vaultwarden.ts` reads it via
  `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' }`).
  Real, working credentials are required from the very first `cdk synth`, not
  just an account number: the VPC construct performs a live
  `DescribeAvailabilityZones` context lookup. That lookup's result is cached
  in `cdk.context.json` — **commit that file** once it appears, so later
  synths are reproducible and work offline.
- **A container runtime**, because the application function
  (`lib/constructs/application.ts`) is built from `docker/vaultwarden/Dockerfile`
  as a `DockerImageFunction` asset. `npx cdk deploy` builds this image and
  needs a running daemon; `npm test` does not — CDK only hashes the asset
  directory at synthesis time, so the unit test suite runs with no runtime
  installed. On this machine that runtime is
  [Colima](https://github.com/abiosoft/colima), which does **not** start
  itself after a reboot:
  ```bash
  colima start   # before any cdk deploy
  colima stop    # afterwards, to release its ~4 GB of RAM
  ```
  Docker Desktop or OrbStack work the same way if used instead.
- **Python 3 with a virtualenv**, to run the backup Lambda's own test suite.
  These tests are pytest-based and are **not** run by `npm test` (jest only
  scans `test/*.test.ts`; the Python tests live under `lambda/backup/`).
  The Lambda runtime itself is Python 3.12 (`lib/constructs/backup.ts`,
  `runtime: lambda.Runtime.PYTHON_3_12`); locally any recent Python 3 works:
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install -r lambda/backup/requirements-dev.txt
  .venv/bin/python -m pytest lambda/backup -v
  ```

## 4. First deployment

```bash
npm ci
npm test
npx cdk bootstrap aws://<ACCOUNT>/eu-west-1
npx cdk deploy                      # DOMAIN is still the placeholder
# Copy CdnDomainName from the outputs into cdk.json as vaultwarden:domain,
# and set vaultwarden:alertEmail while you are there.
npx cdk deploy                      # second pass applies the real DOMAIN
```

**Why two passes.** The CloudFront distribution's domain name does not exist
until CloudFormation creates the distribution, but the application Lambda's
`DOMAIN` environment variable needs that same domain name for absolute URL
generation. Wiring `distribution.distributionDomainName` straight into the
function's environment would make the dependency graph circular: function →
Function URL → distribution → function. `lib/vaultwarden-stack.ts` breaks the
cycle instead by reading `vaultwarden:domain` from CDK context (defaulting to
the placeholder `https://localhost` if unset) and printing the real value as
the `CdnDomainName` stack output once the distribution exists:

1. First `cdk deploy` — `DOMAIN` takes its placeholder default.
2. Read `CdnDomainName` from the stack outputs.
3. Put it in `cdk.json` under the `vaultwarden:domain` context key.
4. `cdk deploy` again — the function is updated with the real domain.

Every deployment after this first one is single-pass; the domain does not
change again unless the distribution itself is replaced.

`cdk.json`'s context keys, all read in `lib/vaultwarden-stack.ts`:

| Key                        | Purpose                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| `vaultwarden:domain`        | Public URL, used for absolute link generation. Placeholder until pass 2. |
| `vaultwarden:alertEmail`    | Subscriber address for the $1/month `CostGuard` budget alert. Optional — no alert is created if unset. |
| `vaultwarden:imageTag`      | Vaultwarden container tag, passed to the Dockerfile's `VW_TAG` build arg. See [Upgrading](#8-upgrading-vaultwarden). |

## 5. First login

Open the URL from the `CdnDomainName` stack output in a browser, create the
one owner account, and before doing anything else in the vault:

- Enable TOTP two-step login, using a **separate** authenticator app on
  another device — never the vault's own built-in authenticator for this
  account's own second factor. Storing the seed for your Vaultwarden login
  inside the vault it protects collapses both factors into one: whoever
  reaches the vault also reaches the code that unlocks it.
- Vaultwarden shows a recovery code exactly once at TOTP enrolment. **Write it
  on paper and store it away from your phone.** This is your primary way back
  in if the authenticator device is lost — see
  [Security notes](#10-security-notes) for the full lockout story.
- Confirm `SIGNUPS_ALLOWED` is `false` (it already is, set in
  `lib/constructs/application.ts`) and that `/admin` returns 404 — the admin
  panel is disabled by leaving `ADMIN_TOKEN` unset, not by a route guard.

## 6. Verifying the endpoint is closed

The application Lambda's Function URL uses `authType: AWS_IAM`
(`lib/constructs/application.ts`), and CloudFront signs every origin request
with SigV4 through an Origin Access Control. An unsigned direct request to the
raw Function URL must be rejected:

```bash
FN_URL=$(aws lambda get-function-url-config --function-name vaultwarden \
  --region eu-west-1 --query FunctionUrl --output text)
curl -s -o /dev/null -w '%{http_code}\n' "$FN_URL"   # expect 403
```

If this returns anything other than `403`, do not put real passwords in the
vault until it does — it means the function is reachable by anyone who finds
its URL, bypassing CloudFront entirely.

## 7. Testing the restore

**An untested backup is not a backup.** Run this once, before the vault holds
anything you cannot afford to lose, and periodically afterwards.

The nightly `vaultwarden-backup` Lambda (`lib/constructs/backup.ts`) writes a
gzipped, consistent SQLite snapshot to the S3 bucket named in the
`BackupBucketName` stack output. That Lambda's IAM role is granted
**`s3:PutObject` only** — deliberately write-only, so that if the backup
function or its role were ever compromised, it could not read past snapshots
back out or delete them. Consequently the restore below is **not** something
the backup Lambda can do for you: it is a manual action you take with your
own AWS credentials, which do have read access to the bucket.

1. Find a snapshot to restore:
   ```bash
   BUCKET=$(aws cloudformation describe-stacks --stack-name VaultwardenStack \
     --region eu-west-1 \
     --query "Stacks[0].Outputs[?OutputKey=='BackupBucketName'].OutputValue" \
     --output text)
   aws s3 ls "s3://$BUCKET/db/" --region eu-west-1
   ```
2. Stop the application function from writing to the database while you
   restore, by setting its reserved concurrency to zero:
   ```bash
   aws lambda put-function-concurrency --function-name vaultwarden \
     --region eu-west-1 --reserved-concurrent-executions 0
   ```
3. Download and decompress the chosen snapshot with your own credentials
   (the backup role cannot do this step — it has no `GetObject` grant):
   ```bash
   aws s3 cp "s3://$BUCKET/db/<snapshot>.gz" ./restore.sqlite3.gz --region eu-west-1
   gunzip restore.sqlite3.gz
   ```
4. Write the file to `/mnt/data/db.sqlite3` on the EFS access point. The
   isolated subnet has no route from your laptop, so this has to happen from
   something inside the VPC — a temporary EC2 instance placed in the same
   `PRIVATE_ISOLATED` subnet with the access point mounted over NFS is the
   simplest option (`sudo mount -t efs -o tls,accesspoint=<id> <fs-id>: /mnt`),
   matching uid/gid 1000 as the access point requires
   (`lib/constructs/storage.ts`). If infrastructure was lost entirely, redeploy
   first with `npx cdk deploy` — EFS uses `removalPolicy: RETAIN`, so it
   normally survives a stack deletion and this step is not needed.
5. Verify the restored file before trusting it:
   ```bash
   sqlite3 restore.sqlite3 "PRAGMA integrity_check;"   # must print: ok
   ```
6. Restore the application function's concurrency:
   ```bash
   aws lambda put-function-concurrency --function-name vaultwarden \
     --region eu-west-1 --reserved-concurrent-executions 10
   ```
   (10, not 1 — that is the deployed `reservedConcurrentExecutions` for
   `vaultwarden` in `lib/constructs/application.ts`, chosen so a browser's
   burst of parallel asset requests does not get rejected with 429s.)

## 8. Upgrading Vaultwarden

Change `vaultwarden:imageTag` in `cdk.json` to the new tag, then:

```bash
npx cdk deploy
```

This is a real, wired-through upgrade, not a cosmetic setting: the Dockerfile
declares `ARG VW_TAG` before its `FROM` line, and `lib/constructs/application.ts`
passes `buildArgs: { VW_TAG: props.imageTag }` when building the image asset,
so changing the context key changes the base image CDK builds and deploys.

**Never remove `ENABLE_DB_WAL=false`** from the application function's
environment when doing this or any other change. Vaultwarden turns SQLite's
WAL mode on at startup by default; WAL coordinates readers through a
memory-mapped shared file, which EFS (an NFS-based filesystem) does not
support, so the container aborts with `Failed to turn on WAL` and never serves
a request again. It must be present from the very first boot — even a single
startup without it is enough to write WAL mode into the database file, after
which the database itself needs repair, not just a config fix.

## 9. Known limitations

- **No push notifications.** Function URLs do not support WebSocket. Clients
  fall back to polling; cross-device sync lags by a few minutes.
- **No email.** No email-based 2FA, password hints, or invitations. TOTP
  works.
- **Website favicons cost privacy, not money.** The stack sets
  `ICON_SERVICE=duckduckgo` (`lib/constructs/application.ts`), so the function
  answers icon requests with an HTTP redirect instead of fetching the image
  itself — no outbound internet from the VPC is needed. But the *client*
  (browser extension, app, or web vault) then fetches each icon directly from
  DuckDuckGo, which reveals the domains stored in the vault to DuckDuckGo and
  to whatever network the client is on. Vaultwarden's `internal` icon mode
  avoids that entirely — icons are fetched and cached by the server, so the
  client only ever talks to this stack — but it is the one mode that needs
  outbound internet, which would mean a NAT Gateway at $32.85/month, roughly
  180x this stack's entire budget. See §3.4 and §6 of the design spec for the
  full reasoning.
- **Attachments and Sends capped at 6 MB** by the Lambda payload limit.
- **Cold start of 2–4 seconds** on the first request after idle.
- **Single AZ.** An AZ failure makes the vault unavailable until restored from
  S3.

## 10. Security notes

### Owner obligations

1. Set `SIGNUPS_ALLOWED=false` immediately after creating the owner account.
2. Use a long, unique master password. **There is no recovery.** Losing it
   loses everything, permanently.
3. Enable TOTP two-factor authentication with a separate authenticator app,
   and store the recovery code offline. See below.
4. Leave `ADMIN_TOKEN` unset. If the admin panel is ever needed, enable it in
   a temporary deployment and remove it afterwards.
5. Enable MFA on the AWS root account and do not use root for daily work.

### Two-factor authentication

TOTP is the only viable second factor for this deployment. Validation is an
HMAC-SHA1 computation over a time counter, requiring neither outbound
internet nor email — the two things the isolated VPC does not provide. The
Lambda clock is NTP-synchronised by AWS, so drift is not a concern. The web
vault needed to enrol a device ships inside the official image.

WebAuthn/FIDO2 is deliberately not used: it binds the credential to an
origin, and the two-pass first deployment leaves `DOMAIN` at a placeholder
until the second pass, which would invalidate a key registered in between.
TOTP is origin-independent.

**Lockout risk.** With the admin panel disabled and no email, the usual 2FA
reset paths do not exist. Two recovery routes:

1. The **recovery code** Vaultwarden displays once at enrolment. Record it on
   paper, stored separately from the phone. This is the primary route.
2. Infrastructure ownership. Redeploy with `ADMIN_TOKEN` temporarily set,
   clear the 2FA entry through `/admin`, then deploy again without it. The
   EFS database is also directly reachable from a one-off maintenance
   function.

Route 2 is what makes disabling the admin panel safe here rather than
reckless. It is not available to a self-hoster without infrastructure access.

**Vault-stored TOTP seeds** (Bitwarden's built-in authenticator) are a
separate feature. Vaultwarden grants premium status to all users by default,
so it is available. Codes are generated client-side from an encrypted seed;
the server never sees the plaintext and is not involved in the computation,
so cold starts and the absent internet path are irrelevant.

Do **not** store the Vaultwarden account's own TOTP seed in the vault it
protects — that collapses both factors into one. Use a separate
authenticator application for it.

### The endpoint is public, and cannot be otherwise

Official Bitwarden clients are ordinary HTTPS clients. They cannot sign
SigV4 requests, send arbitrary headers, or present client certificates. Any
endpoint reachable by your phone is reachable by the internet — this is a
property of the client protocol, not a gap in this design. CloudFront + OAC
does not make the service private; it relocates the public entry point to a
service that can be hardened (rate limiting, no direct Lambda invocation,
closed signups, no admin panel) and closes off direct invocation of the
function itself. See §5 of the design spec for the full threat model.
