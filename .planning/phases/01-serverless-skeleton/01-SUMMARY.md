# Plan 01 Summary — Serverless infrastructure

Executed: 2026-08-18. All `must_haves` met.

## What was done

- **Deleted** all Docker/EFS/backup code: `docker/`, `lambda/backup/`, `lib/constructs/{application,storage,backup}.ts`, their tests, `cdk.context.json` (AZ pin), stale compiled `.js`/`.d.ts` artifacts, `.venv`, `.pytest_cache`.
- **cdk.json**: removed `vaultwarden:imageTag` + `vaultwarden:adminToken`; kept domain/cert/alertEmail/signupsAllowed.
- **bin/vaultwarden.ts**: description updated; account/region resolution untouched.
- **package.json**: added `esbuild` (0.25.12) + `@types/aws-lambda` (8.10.162 — `^4` doesn't exist anymore) as devDependencies. Zero runtime deps.
- **lib/vaultwarden-stack.ts** rewritten:
  - `VaultTable`: single-table `pk`/`sk`, PAY_PER_REQUEST, PITR, RETAIN
  - 3 buckets: attachments (versioned), static-webvault (private, BLOCK_ALL), icons — all DESTROY + autoDelete
  - Node 22 Lambda (512 MB, 30s) with env `VERSION`/`SIGNUPS_ALLOWED`/`DEFAULT_DOMAIN`; `DescribeTable` read grant
  - `HttpApi` with `$default` catch-all → Lambda
  - CloudFront: default → S3 via **OAC** (`S3BucketOrigin.withOriginAccessControl` — `S3Origin` would have created legacy OAI), 5 uncached API behaviors sharing ONE api origin, custom domain when cert present
  - `CostGuard` kept, warning when alertEmail blank (backup-alarm wording dropped)
- **src/handler.ts** shell (V2 event types — `rawPath`/`requestContext.http` are the `APIGatewayProxyEventV2` shape; HTTP API integrations default to payload 2.0): `/alive` → 200 empty, else Bitwarden 404 envelope, logs requestId.
- **src/router.ts**: `match()` exact-first, `:param` patterns, URL-decoded params, ≤40 lines, no deps.
- **test/stack.test.ts** rewritten from snapshot-style asserts to `Template.fromStack` property asserts (bucket/table/lambda/api-gw/CF+OAC/behaviors/budget); **test/router.test.ts** new.

## Deviations from plan

- `@types/aws-lambda` `^4` does not exist on npm → `^8.10.162` (latest).
- Plan's `APIGatewayProxyEvent` type is the REST-API shape; HTTP API events need the V2 types.
- CDK 2.263 warns `pointInTimeRecovery` deprecated → used `pointInTimeRecoverySpecification`; `S3Origin` deprecated → `S3BucketOrigin.withOriginAccessControl` (this is what makes OAC instead of OAI).

## Verification

- `npm test`: 17/17 green
- `cdk context --clear` then `npm run synth`: green offline (no EFS AZ lookup)
- template has DynamoDB/HttpApi/CloudFront/OAC; zero `efs|elasticfilesystem|dockerfile` matches in lib/bin/test/cdk.json/package.json