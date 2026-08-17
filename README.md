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
| CloudWatch custom metric (`SnapshotBytes`, 1 of 10 free) | $0                  | $0                 |
| AWS Backup on EFS — explicitly **disabled**            | $0                    | $0                 |
| Data transfer out (100 GB/month free, perpetual)       | $0                    | $0                 |
| **Total**                                              | **$0.00/month**       | **≈ $0.18/month**  |

For comparison: Lightsail's cheapest instance is $3.50/month; a Fargate
equivalent is roughly $10/month; a NAT Gateway alone would be $32.85/month.

Two line items are there to name things that are *not* billed but easily could
be. AWS Backup is one: `CreateFileSystem` defaults automatic backups to `false`
**except** when `AvailabilityZoneName` is specified, which the One Zone storage
class does — so this stack would silently run daily AWS Backup jobs against the
vault filesystem if `lib/constructs/storage.ts` did not turn them off through an
L1 escape hatch. That would be both an unbudgeted recurring charge and a
mid-write file copy of a live SQLite database, which is the exact failure mode
the nightly SQLite online backup exists to avoid. Verify it after deploying —
see [First deployment](#4-first-deployment). The other is an interface VPC
endpoint for the Lambda control plane, at $7.30/month; §7 explains what is done
instead.

A CDK-deployed AWS Budgets alert (`CostGuard`) fires at $1/month forecast
spend — but **only if `vaultwarden:alertEmail` is set**. It is blank in
`cdk.json` as shipped, and blank means no budget and no backup-failure alarm
exist at all. Set it before the first deploy; see
[Prerequisites](#3-prerequisites).

## 3. Prerequisites

- **Node.js 24** and npm (the CDK app, `bin/vaultwarden.ts`, runs via
  `ts-node`; dependencies are `aws-cdk-lib` 2.263.0 and CDK CLI 2.1135.0, both
  pinned in `package.json`).
- **AWS credentials** for the target account, plus the account number in the
  environment. `bin/vaultwarden.ts` resolves it as
  `DEFAULT_ACCOUNT ?? CDK_DEFAULT_ACCOUNT`, and the region as
  `DEFAULT_REGION ?? CDK_DEFAULT_REGION ?? 'eu-west-1'`, so either variable
  works. `dotenv` is loaded first, so a git-ignored `.env` holding
  `DEFAULT_ACCOUNT` and `DEFAULT_REGION` is the tidiest option and keeps the
  account number out of your shell history and out of the repository. The
  region must never resolve to nothing: an environment-agnostic stack fails at
  synth because EFS One Zone needs a concrete availability zone, and the error
  does not mention the missing variable.
  Real, working credentials are required from the very first `cdk synth`, not
  just an account number: the VPC construct performs a live
  `DescribeAvailabilityZones` context lookup. That lookup's result is cached
  in `cdk.context.json`.
- **An alert email address**, set as `vaultwarden:alertEmail` in `cdk.json`
  before the first deploy. This is not optional decoration: it is the single
  subscriber for *both* the nightly-backup failure alarm and the $1/month
  budget, and both constructs are skipped entirely when it is blank (an SNS
  subscription or a budget subscriber with an empty address fails at deploy
  time, so they cannot simply be created with nothing in them). Leave it blank
  and the stack deploys with no failure alarm and no cost alert at all —
  `cdk synth` prints a warning to that effect. Composed with the backup
  bucket's 90-day expiry, that means a nightly backup which starts failing is
  invisible until the last good snapshot has already expired. Any address you
  actually read is fine; confirm the SNS subscription email that arrives after
  the first deploy, or the alarm can never notify you.
- **`cdk.context.json`, once it appears, must be committed — this is a
  data-safety control, not a convenience.** The EFS filesystem's
  `AvailabilityZoneName` is derived from `vpc.availabilityZones[0]`, and that
  property is immutable: CloudFormation cannot change it in place, so a
  different value **replaces the filesystem**. `UpdateReplacePolicy: Retain`
  means the old one survives as an orphan — but all three Lambda functions
  follow the stack to the new, empty filesystem, and the nightly backup job
  will happily start taking snapshots of *that* instead. Ninety days later the
  snapshots holding the real vault have expired. Deleting or regenerating
  `cdk.context.json` re-runs the `DescribeAvailabilityZones` lookup, and AWS
  does not guarantee that list comes back in the same order. The committed file
  is what pins it. (It also makes later synths reproducible and offline-capable,
  which is the far less important reason to keep it.)
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

The first deployment is **two passes**, and the owner account is created
between them. Do not stop after pass 1.

```bash
npm ci
npm test
npx cdk bootstrap aws://<ACCOUNT>/eu-west-1

# Pass 1 — placeholder DOMAIN, registration open just long enough to create
# the one owner account.
npx cdk deploy --context vaultwarden:signupsAllowed=true

#   → Now go and do §5 First login: open CdnDomainName, register the owner
#     account, enrol TOTP. The server is registrable by anyone who finds the
#     URL until pass 2 lands, so do this now, not tomorrow.
#   → Copy CdnDomainName from the outputs into cdk.json as
#     vaultwarden:domain, and set vaultwarden:alertEmail while you are there.

# Pass 2 — real DOMAIN, and registration back to closed (the cdk.json
# default; note there is no --context flag on this one).
npx cdk deploy
```

**Why the first pass has to allow signups.** Vaultwarden 1.37.1 accepts a
registration only when `Invitation::take(&email, …) ||
CONFIG.is_signup_allowed(&email)` (`src/api/core/accounts.rs`). There is no
"first user is special" exception. This stack has no `ADMIN_TOKEN` (so no
`/admin` to send an invitation from) and no SMTP (so no invitation email), which
leaves `SIGNUPS_ALLOWED` as the only route to an account existing at all. A
deploy that ships it `false` from the start is a vault nobody can ever log into.

**Why pass 2 is not optional.** While `SIGNUPS_ALLOWED` is `true`, *anyone* who
reaches the CloudFront URL can create an account on your server. They cannot
read your vault — everything is encrypted client-side under your master password
— but they can consume your Lambda invocations and store their own data on your
EFS, and you would have no way to notice. Closing registration again is what
makes this a single-user server.

**Why two passes at all.** The CloudFront distribution's domain name does not
exist until CloudFormation creates the distribution, but the application
Lambda's `DOMAIN` environment variable needs that same domain name for absolute
URL generation. Wiring `distribution.distributionDomainName` straight into the
function's environment would make the dependency graph circular: function →
Function URL → distribution → function. `lib/vaultwarden-stack.ts` breaks the
cycle instead by reading `vaultwarden:domain` from CDK context (defaulting to
the placeholder `https://localhost` if unset) and printing the real value as
the `CdnDomainName` stack output once the distribution exists. The account
bootstrap rides along in the same two passes rather than adding a third.

Every deployment after this first one is single-pass; the domain does not
change again unless the distribution itself is replaced.

**Confirm both settings landed** after pass 2:

```bash
aws lambda get-function-configuration --function-name vaultwarden \
  --region eu-west-1 --query 'Environment.Variables.{domain:DOMAIN,signups:SIGNUPS_ALLOWED}'
# expect the real CloudFront URL, and "false"

# AWS Backup on the EFS filesystem must be DISABLED. The One Zone storage
# class flips CreateFileSystem's automatic-backup default from false to true,
# so this is turned off explicitly in lib/constructs/storage.ts — verify it
# actually took, because a daily AWS Backup job is both an unbudgeted charge
# and a mid-write file copy of a live SQLite database.
FS_ID=$(aws cloudformation describe-stack-resources --stack-name VaultwardenStack \
  --region eu-west-1 \
  --query "StackResources[?ResourceType=='AWS::EFS::FileSystem'].PhysicalResourceId" \
  --output text)
aws efs describe-backup-policy --region eu-west-1 --file-system-id "$FS_ID"
# expect: {"BackupPolicy": {"Status": "DISABLED"}}
```

`cdk.json`'s context keys, all read in `lib/vaultwarden-stack.ts`:

| Key                        | Purpose                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| `vaultwarden:domain`        | Public URL, used for absolute link generation. Placeholder until pass 2. |
| `vaultwarden:signupsAllowed` | Whether new accounts can be registered. `"false"` by default and in steady state. Set to `"true"` for the pass-1 bootstrap deploy only — it is the only way the owner account can be created. Anything other than exactly `"true"` leaves registration closed. |
| `vaultwarden:alertEmail`    | Subscriber address for the $1/month `CostGuard` budget alert **and** the nightly-backup failure alarm. Blank by default, and blank means neither exists — `cdk synth` prints a warning saying so. |
| `vaultwarden:imageTag`      | Vaultwarden container tag, passed to the Dockerfile's `VW_TAG` build arg. See [Upgrading](#8-upgrading-vaultwarden). |
| `vaultwarden:adminToken`    | The 2FA-lockout escape hatch. Blank by default, which is what keeps `/admin` disabled. See [Security notes](#10-security-notes). |

## 5. First login

This happens **between the two deploys in §4**, while pass 1's
`vaultwarden:signupsAllowed=true` is live. Registration is closed before pass 1
and closed again after pass 2; this is the only window in which the account can
be created.

Open the URL from the `CdnDomainName` stack output in a browser, create the one
owner account, and before doing anything else in the vault:

- Enable TOTP two-step login, using a **separate** authenticator app on
  another device — never the vault's own built-in authenticator for this
  account's own second factor. Storing the seed for your Vaultwarden login
  inside the vault it protects collapses both factors into one: whoever
  reaches the vault also reaches the code that unlocks it.
- Vaultwarden shows a recovery code exactly once at TOTP enrolment. **Write it
  on paper and store it away from your phone.** This is your primary way back
  in if the authenticator device is lost — see
  [Security notes](#10-security-notes) for the full lockout story.
- Confirm `/admin` returns 404 — the admin panel is disabled by leaving
  `ADMIN_TOKEN` unset, not by a route guard.

Then go straight back to §4 and run pass 2, which closes registration. Verify
it: the registration page must refuse a second account afterwards, and
`get-function-configuration` must report `SIGNUPS_ALLOWED` as `false`.

If you ever need a second account later (a family member, a replacement
device's own login), it is the same shape: deploy once with
`--context vaultwarden:signupsAllowed=true`, register, deploy again without it.

## 6. Verifying the endpoint is closed

The application Lambda is served through a Function URL with `authType: NONE`
(`lib/constructs/application.ts`). It must be `NONE` — an `AWS_IAM` URL rejects
every browser POST (CloudFront's Origin Access Control signs origin requests
as unsigned payloads and Function URLs refuse those with
`SignatureDoesNotMatch`), and API Gateway HTTP APIs reject the web vault's
9.1 MB SDK chunk outright (buffered Lambda responses cap at 6 MB, which the
4.9 MB argon2 wasm also blows past once base64-inflated; streaming only works
over REST APIs or Function URLs, never HTTP APIs). Both alternatives were
tried and removed.

What keeps this endpoint closed is therefore not authentication (a `NONE`
URL cannot authenticate) but **obscurity plus discipline**:

- the URL is a 26-character random ID that is never logged, exported as a
  stack output, or written anywhere outside the CloudFront origin
  configuration — anyone who knows it can call the function directly, but the
  web vault, the API paths, and the TLS certificate all answer only on the
  CloudFront domain;
- registration is closed (`SIGNUPS_ALLOWED: false`), so a direct caller can
  probe but cannot create an account (see §4).

Verify the shape that actually keeps it closed:

```bash
aws lambda get-function-url-config --function-name vaultwarden \
  --region eu-west-1 --query '{auth:AuthType,invoke:InvokeMode}'
# expect NONE and RESPONSE_STREAM — the latter is load-bearing: without it the
# web vault's big assets return 500 and account creation breaks client-side.
```

Sharing the raw URL anywhere (bug reports, the RUNBOOK, this README) or
exporting it as a stack output is what would open it; if that ever happens,
rotate it by redeploying the function.

## 7. Testing the restore

**An untested backup is not a backup.** Run this once, before the vault holds
anything you cannot afford to lose, and periodically afterwards.

The nightly `vaultwarden-backup` Lambda (`lib/constructs/backup.ts`) writes a
gzipped, consistent SQLite snapshot to the S3 bucket named in the
`BackupBucketName` stack output. That Lambda's IAM role is granted
**`s3:PutObject` only** — deliberately write-only, so that if the backup
function or its role were ever compromised, it could not read past snapshots
back out or delete them.

### Watching the snapshot size

Each successful backup logs one CloudWatch Embedded Metric Format line, which
publishes `Vaultwarden/SnapshotBytes` — the uncompressed size of the database it
just uploaded (`emit_snapshot_size_metric` in `lambda/backup/index.py`). It is a
structured log line, not a new AWS resource, and one custom metric sits inside
CloudWatch's always-free allowance.

It exists because the backup job's validation cannot catch the worst silent
failure. Validation checks `PRAGMA integrity_check` and that the schema is
non-empty — deliberately not that specific Vaultwarden tables exist, since that
would couple the backup job to upstream's schema and turn a Vaultwarden upgrade
into a silent backup outage. But a **freshly-migrated, completely empty**
database passes both checks: full schema, zero users. That is the state after
anything that replaces the EFS filesystem, or after an erroneous restore. Ninety
nightly uploads later, every snapshot that held the real vault has expired under
the bucket's lifecycle rule, and nothing ever reported a problem. Size is the
signal that distinguishes the two: an empty vault is tens of KB, a real one is
not, and a real one does not shrink.

No alarm is created for you, on purpose — a threshold chosen at deploy time,
before any data exists, would only produce noise. Once the vault has been in use
long enough that you know its normal size, add one yourself. Look at a few days
of the metric first:

```bash
aws cloudwatch get-metric-statistics --region eu-west-1 \
  --namespace Vaultwarden --metric-name SnapshotBytes \
  --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 86400 --statistics Minimum Maximum
```

then set a floor at something comfortably below the smallest real value and
comfortably above an empty database — half your current size is a reasonable
starting point:

```bash
aws cloudwatch put-metric-alarm --region eu-west-1 \
  --alarm-name vaultwarden-snapshot-too-small \
  --namespace Vaultwarden --metric-name SnapshotBytes \
  --statistic Minimum --period 86400 --evaluation-periods 1 \
  --threshold <half-your-normal-size-in-bytes> \
  --comparison-operator LessThanThreshold \
  --treat-missing-data breaching \
  --alarm-actions "$(aws sns list-topics --region eu-west-1 \
    --query "Topics[?contains(TopicArn, 'vaultwarden-backup-alarms')].TopicArn" --output text)"
```

`--treat-missing-data breaching` is deliberate: no metric at all means no backup
ran, which is the thing you most want to hear about. The alarm action reuses the
SNS topic the stack already creates from `vaultwarden:alertEmail`; both the
topic and the alarm fall inside CloudWatch's free allowance.

Restoring is done by a second Lambda, `vaultwarden-restore`
(`lib/constructs/backup.ts`, code in `lambda/backup/restore.py`), not by a
hand-launched EC2 instance. The isolated VPC has no SSH/SSM path to a
temporary instance and no security group rule admitting one to EFS — a
restore procedure built around one cannot actually be carried out. The
restore function instead gets the same EFS access the application and backup
functions already have, plus its own IAM role with **read** access to the
backup bucket (`s3:GetObject` and the listing action its `list` action needs).
This does **not** weaken the backup role's write-only property above: they
are two separate functions with two separate roles. A compromised backup
role still cannot read or delete historical snapshots — only the restore
role can, and unlike the backup role it is never invoked automatically
(there is no EventBridge schedule for it; only a human invokes it). It costs
$0 — a function that is never invoked is never billed.

1. Find a snapshot to restore, by invoking the restore function with the
   `list` action (no console access to the bucket needed):
   ```bash
   aws lambda invoke --function-name vaultwarden-restore \
     --region eu-west-1 \
     --payload '{"action": "list"}' --cli-binary-format raw-in-base64-out \
     /tmp/restore-list.json
   cat /tmp/restore-list.json   # {"status": "ok", "keys": ["db/2026-08-04T03-00-00Z.sqlite3.gz", ...]}
   ```
2. Stop the application function from writing to the database while you
   restore, by setting its reserved concurrency to zero — **and verify it
   yourself**, because the restore function cannot verify it for you (step 3
   explains why):
   ```bash
   aws lambda put-function-concurrency --function-name vaultwarden \
     --region eu-west-1 --reserved-concurrent-executions 0
   aws lambda get-function-concurrency --function-name vaultwarden \
     --region eu-west-1
   # expect: {"ReservedConcurrentExecutions": 0}
   ```
   Do not continue until that command has printed `0`. This is the step that
   keeps Vaultwarden from writing into a database that is being replaced under
   it.
3. Invoke the restore function with the chosen key, the exact confirmation
   phrase, **and `"force": true`**. This is the one step that overwrites the
   live database, so it is guarded in depth: the function refuses unless
   `confirm` is exactly `OVERWRITE-VAULT`, validates the downloaded snapshot
   before touching anything at the live path, copies the current database aside
   to a timestamped name before overwriting it, swaps the new file into place
   with an atomic `os.replace` rather than writing the live path directly, and
   then moves the old database's SQLite sidecar files out of the way.
   ```bash
   aws lambda invoke --function-name vaultwarden-restore \
     --region eu-west-1 \
     --payload '{"action": "restore", "key": "db/2026-08-04T03-00-00Z.sqlite3.gz", "confirm": "OVERWRITE-VAULT", "force": true}' \
     --cli-binary-format raw-in-base64-out \
     /tmp/restore-result.json
   cat /tmp/restore-result.json
   # {"status": "ok", "key": "db/...", "bytes": 53248,
   #  "preserved": "/mnt/data/db.sqlite3.preserved-2026-08-04T12-00-00Z",
   #  "stale_sidecars": []}
   ```
   **Why `"force": true` is the normal payload here, not an escape hatch.**
   Without it, the function first calls `lambda:GetFunctionConcurrency` to
   confirm step 2 for itself. That is a Lambda *control-plane* call, and
   `vaultwarden-restore` runs in a `PRIVATE_ISOLATED` subnet of a VPC with no
   NAT gateway whose only endpoint is the free S3 gateway endpoint.
   `lambda.eu-west-1.amazonaws.com` resolves but is not routable from there, so
   the call is black-holed — it can never succeed. An interface VPC endpoint
   would fix it and cost $7.30/month against a stack that costs about
   $0.18/month, so there is not one. The check is kept in the code (it works
   outside the VPC, and would start working if AWS networking ever changed) but
   the client is configured with a 3-second connect timeout instead of
   botocore's 60, so if you do omit `force` you get an explicit message telling
   you all of this within a few seconds instead of a five-minute silent hang.
   **You** verifying step 2 is what replaces the automated check.

   Forcing costs you nothing else. The preserved copy is taken with SQLite's
   online backup API (`index.snapshot_database`, the same one the nightly job
   uses), not a byte copy, so it is a consistent database whether or not
   anything was still writing — `preserved` is a real undo path, and `force`
   does not weaken it. The one exception is a live database SQLite cannot open
   at all, which is preserved verbatim under a `.preserved-raw-` name instead;
   that file is for forensics, since it was not a working database before the
   restore either.

   `stale_sidecars` lists any SQLite sidecar files (`-journal`, `-wal`, `-shm`)
   that were sitting beside the old database and have been renamed out of the
   way. This is not cosmetic: a rollback journal is bound to a *path*, not to
   the database that wrote it, so one left beside the restored database would
   be treated as a hot journal on the next open and rolled into it — corrupting
   a database that validated as sound seconds earlier. With `ENABLE_DB_WAL=false`
   this deployment runs in rollback-journal mode, so `db.sqlite3-journal` exists
   whenever a transaction is in flight, including when an execution environment
   is reclaimed mid-write. That is exactly the kind of event that leads to a
   restore, so expect this list to be non-empty in a real recovery.
4. Restore the application function's concurrency:
   ```bash
   aws lambda put-function-concurrency --function-name vaultwarden \
     --region eu-west-1 --reserved-concurrent-executions 10
   ```
   (10, not 1 — that is the deployed `reservedConcurrentExecutions` for
   `vaultwarden` in `lib/constructs/application.ts`, chosen so a browser's
   burst of parallel asset requests does not get rejected with 429s.)

**If the infrastructure itself is gone. Do this first, before anything else:
copy the snapshots out of the orphaned bucket to somewhere you control.**

```bash
aws s3 ls | grep vaultwarden          # find the orphaned bucket
aws s3 cp "s3://<orphaned-bucket-name>/db/" ./vaultwarden-snapshots/ \
  --recursive --region eu-west-1
```

The bucket's 90-day lifecycle rule is still running. It does not pause because
the stack is gone, and it expires noncurrent versions on the same schedule, so
versioning will not save an object it has already deleted. Every hour spent
deciding how to recover is an hour of that clock. Get the bytes onto a disk you
own first; decide what to do with them afterwards.

`removalPolicy: RETAIN`
(`lib/constructs/storage.ts`) stops AWS from deleting the EFS filesystem and
the S3 backup bucket when the stack is destroyed — but neither is
automatically re-adopted by a fresh deploy. **Both** need an explicit
[`cdk import`](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-import)
before any of the steps above will work, and both need it for the same
reason: `cdk deploy` after a stack loss creates a **new**
`AWS::EFS::FileSystem` and a **new** `AWS::S3::Bucket`, each with a new
physical ID/name, not a reattachment to the orphaned resource. The bucket has
no explicit `bucketName` in `lib/constructs/storage.ts` specifically so a
clean-account deploy never collides with a still-retained bucket from a
previous stack — but that same lack of a fixed name is what makes the new
bucket unrelated to the old one. `vaultwarden-restore`'s `BUCKET_NAME`
environment variable is wired from `props.bucket.bucketName`
(`lib/constructs/backup.ts`), i.e. whatever bucket exists in the **current**
stack. Skip the import and the restore function is not broken — it works
perfectly well against the new, empty bucket. `{"action": "list"}` will
simply return an empty list, and every real snapshot will sit untouched in
the orphaned bucket with no indication anything is wrong.

So, in order, after a full stack loss:

1. Copy the snapshots out of the orphaned bucket, as above. The lifecycle
   clock does not stop for the rest of this list.
2. `cdk import` the retained EFS filesystem's physical ID into the new stack.
3. `cdk import` the retained S3 bucket's name into the new stack.
4. Only then proceed with steps 1–4 above.

**Out-of-band fallback, if you cannot or do not want to `cdk import` the
bucket** (for example, to inspect what is there before deciding). This uses
your own AWS credentials directly against S3, the same way the pre-Task-9
procedure did, and is deliberately kept as the fallback rather than the
primary route — `vaultwarden-restore` remains the normal way to restore,
including its validation, preservation, and atomic-swap guarantees, none of
which this fallback provides on its own:

```bash
# Find the orphaned bucket — it will not be the current BackupBucketName
# stack output, since that now names the new stack's (empty) bucket.
aws s3 ls | grep vaultwarden

# List and download snapshots directly from it.
aws s3 ls "s3://<orphaned-bucket-name>/db/" --region eu-west-1
aws s3 cp "s3://<orphaned-bucket-name>/db/<snapshot>.gz" ./restore.sqlite3.gz \
  --region eu-west-1
gunzip restore.sqlite3.gz
sqlite3 restore.sqlite3 "PRAGMA integrity_check;"   # must print: ok
```

This fallback only gets a validated snapshot into your own hands — it does
not write it to EFS; `vaultwarden-restore` has no way to reach a bucket that
is not the one named by its own `BUCKET_NAME` environment variable, and there
is no supported way to hand it a local file instead of an S3 key. To finish
the restore, `cdk import` the bucket (step 3 above) so the snapshot is
visible to the current stack under its real key, then continue with the
normal numbered procedure.

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

1. Run deployment pass 2 immediately after creating the owner account, which
   returns `SIGNUPS_ALLOWED` to `false` (§4). Registration has to be open for
   pass 1 or the account cannot be created at all — Vaultwarden has no
   first-user exception, and this stack has no `/admin` and no email to send an
   invitation from — but every minute it stays open is a minute anyone who
   finds the URL can register on your server. Verify with
   `aws lambda get-function-configuration --function-name vaultwarden --region
   eu-west-1 --query 'Environment.Variables.SIGNUPS_ALLOWED'`.
2. Use a long, unique master password. **There is no recovery.** Losing it
   loses everything, permanently.
3. Enable TOTP two-factor authentication with a separate authenticator app,
   and store the recovery code offline. See below.
4. Leave `ADMIN_TOKEN` unset (`vaultwarden:adminToken` blank in `cdk.json`,
   the default). If the admin panel is ever needed, enable it via
   `--context vaultwarden:adminToken=...` for one deployment and remove it
   afterwards — see the 2FA lockout section below.
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
2. Infrastructure ownership:
   ```bash
   npx cdk deploy --context vaultwarden:adminToken=<a-strong-random-value>
   ```
   deploys with `ADMIN_TOKEN` set (`lib/constructs/application.ts`,
   `lib/vaultwarden-stack.ts`), which enables `/admin`. Log in there with the
   token and clear the 2FA entry, then redeploy **without** the context flag
   (or with `vaultwarden:adminToken` back to `""` in `cdk.json` if you put it
   there instead of the CLI) to disable `/admin` again. This is a real
   redeploy, not a config toggle a self-hoster without infrastructure access
   could perform — that is what makes disabling the admin panel by default
   safe here rather than reckless. Prefer passing the token on the command
   line over committing it to `cdk.json`, and never leave a deployment with
   `ADMIN_TOKEN` set longer than the recovery takes.

The EFS database is also directly reachable in an emergency by invoking
`vaultwarden-restore` with a snapshot from *before* the lockout (§7) — not a
2FA-specific tool, but it is another route back to a working vault if the
admin-token route is somehow unavailable.

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
property of the client protocol, not a gap in this design. CloudFront does
not make the service private; it relocates the public entry point to a
service that can be hardened (rate limiting, no advertised origin URL,
closed signups, no admin panel) and keeps the function's own address — a
26-character random ID — unadvertised (§6). See §5 of the design spec for
the full threat model.
