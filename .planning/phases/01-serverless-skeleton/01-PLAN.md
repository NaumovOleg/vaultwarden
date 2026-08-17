---
phase: 01-serverless-skeleton
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [package.json, package-lock.json, cdk.json, cdk.context.json, bin/vaultwarden.ts, lib/vaultwarden-stack.ts, lib/constructs/cost-guard.ts, test/stack.test.ts]
autonomous: true

must_haves:
  truths:
    - "The repository no longer contains Docker, EFS, or backup-Lambda code"
    - "cdk synth succeeds without network lookups (no EFS AZ requirement)"
    - "npm test passes"
  artifacts:
    - "lib/vaultwarden-stack.ts building DynamoDB table, S3 buckets, Node 22 Lambda, API Gateway HTTP API, CloudFront"
    - "src/handler.ts Lambda entry (shell)"
  key_links:
    - "Lambda function → API Gateway catch-all route"
    - "CloudFront default behavior → static S3 bucket via OAC"
    - "CloudFront /api/*, /identity/*, /icons/*, /alive, /now behaviors → API Gateway"
---

<objective>
Replace the Docker/EFS infrastructure with a serverless-native skeleton: DynamoDB + S3 + API Gateway + single Node 22 Lambda + CloudFront, all in the existing `VaultwardenStack`.

Purpose: remove the failure source (container + SQLite-on-EFS) and lay the deployment skeleton every later phase builds on.
Output: new CDK stack and Lambda shell committed, old infra code deleted.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/ARCHITECTURE.md
@lib/vaultwarden-stack.ts
@lib/constructs/cost-guard.ts
@bin/vaultwarden.ts
@cdk.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Delete the old Docker/EFS/backup infrastructure code</name>
  <files>docker/, lambda/backup/, lib/constructs/application.ts, lib/constructs/storage.ts, lib/constructs/backup.ts, test/application.test.ts, test/backup.test.ts, test/dockerfile.test.ts, test/storage.test.ts, cdk.json, cdk.context.json, package.json</files>
  <action>
    Delete: `docker/` (Dockerfile), `lambda/backup/` (Python backup+restore + their tests), `lib/constructs/application.ts`, `lib/constructs/storage.ts`, `lib/constructs/backup.ts`, `test/application.test.ts`, `test/backup.test.ts`, `test/dockerfile.test.ts`, `test/storage.test.ts`. Keep `lib/constructs/cost-guard.ts` (budget alarm pattern survives — INFRA-06).

    Remove from `cdk.json` context: `vaultwarden:imageTag`, `vaultwarden:adminToken`. Keep `vaultwarden:domain`, `vaultwarden:certificateArn`, `vaultwarden:alertEmail`, `vaultwarden:signupsAllowed`. Delete `cdk.context.json` (it only pins the EFS availability zone — no longer needed; do NOT regenerate it).

    Update `bin/vaultwarden.ts`: description → "Multi-user Bitwarden-compatible server on Lambda, DynamoDB, S3 and CloudFront".

    Update `package.json`: the stack will use `aws_lambda_nodejs.NodejsFunction`, which requires `esbuild` at synth time and `@types/aws-lambda` for event typings — add both as devDependencies (esbuild ^0.24.0 or latest, @types/aws-lambda ^4). Do not add runtime dependencies: the Phase-1 Lambda has zero runtime deps (no @aws-sdk yet — the table is not read in this phase). Run `npm install`.
  </verify>
  `rg -rn "dockerfile|Dockerfile|DockerImageFunction|FileSystem|efs|EFS|backup" lib bin test cdk.json package.json | grep -v cost-guard` → empty (case-insensitive). `git status` shows only intended deletions. `npm install` completes cleanly.
  <done>No Docker/EFS/backup references remain. package.json has esbuild + @types/aws-lambda devDeps. cdk.json keeps only domain/cert/alertEmail/signupsAllowed.</done>
</task>

<task type="auto">
  <name>Task 2: Build the serverless CDK infrastructure</name>
  <files>lib/vaultwarden-stack.ts, lib/constructs/cost-guard.ts (only if its props must change), bin/vaultwarden.ts</files>
  <action>
    Rewrite `lib/vaultwarden-stack.ts` (single stack, keep stack name `VaultwardenStack`) to create:

    1. **DynamoDB**: single table `VaultTable`, on-demand billing, `pointInTimeRecovery: true`, `removalPolicy: RETAIN`, partition key `pk` (String) + sort key `sk` (String). Do NOT delete the table on stack destroy (data safety).
    2. **S3 buckets**: `attachments` (private, versioning enabled), `static-webvault` (private, block public access — served through CloudFront OAC), `icons`. All with `removalPolicy: DESTROY` + `autoDeleteObjects: true` (regenerable caches, not data).
    3. **Lambda**: `aws_lambda_nodejs.NodejsFunction`, runtime `NODEJS_22_X`, entry `src/handler.ts` (will exist after Task 3 in this same plan — create the shell file if the directory doesn't exist yet), `memorySize: 512`, `timeout: 30s`, bundling via esbuild (defaults: minify on, source maps off — keep CDK defaults). Environment: `VERSION` from context `vaultwarden:version` (default `"1.0.0-dev"` if absent), `SIGNUPS_ALLOWED` from existing `vaultwarden:signupsAllowed`, and `DEFAULT_DOMAIN` = context domain without scheme (for later phases). Grant the lambda read-only `dynamodb:DescribeTable` on the table so the IAM relationship exists (real CRUD grants come in Phase 2).
    4. **API Gateway**: `HttpApi` with a single default catch-all route (`$default`) proxying to the Lambda. No CORS config (same-origin via CloudFront).
    5. **CloudFront**: distribution serving everything on ONE origin setup:
       - default behavior → origin = `static-webvault` bucket via Origin Access Control (OAC, signed requests), viewer protocol HTTPS, `index.html` as default root object.
       - path behaviors `/api/*`, `/identity/*`, `/icons/*`, `/alive`, `/now` → original origin = the API Gateway `HttpApi` (use `HttpApi.url` as an origin domain via `OriginGroup`? No — single origin, `HttpOrigin(apiUrl)` or CF origin from `HttpApi.url` without the trailing slash protocol; wrap with `CfnDistribution` origins correctly), cache policy `CachingDisabled`.
       - domain: if context `vaultwarden:domain` AND `vaultwarden:certificateArn` are set, add those (aliases + ACM us-east-1 cert, certificateArn is already us-east-1 per cdk.json); otherwise no alias (default cloudfront.net name is fine).
       - Add `index.html` and other static asset defaults — do NOT set 404 fallback (web vault uses hash routing).
    6. Keep the existing `CostGuard` construct wiring (`vaultwarden:alertEmail` behavior unchanged).
    7. Keep `bin/vaultwarden.ts` account/region resolution as-is (DEFAULT_REGION ?? CDK_DEFAULT_REGION ?? "eu-west-1").
  </verify>
  `npm run synth` succeeds offline (no DescribeAvailabilityZones call — region comes from env or default). `cdk.out` contains the new template; `cdk context --clear` then `npm run synth` still succeeds (proves no context lookup dependency). Inspect `cdk.out/*.template.json` via `rg "DynamoDB|NodejsFunction|HttpApi|CloudFront|OriginAccessControl|VaultTable"` → present; `rg "EFS|elasticfilesystem"` → absent.
  <done>Single stack synthesizes offline with table/buckets/lambda/api-gw/cloudfront; OAC wired; no EFS anywhere.</done>
</task>

<task type="auto">
  <name>Task 3: Lambda shell + updated stack tests</name>
  <files>src/handler.ts, src/router.ts (minimal), test/stack.test.ts, test/router.test.ts</files>
  <action>
    Create the Lambda shell so the stack from Task 2 has its entry:
    - `src/handler.ts`: exports `async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult>` (types from `@types/aws-lambda`). Note: with an HTTP API catch-all route the path arrives in `event.rawPath` and method in `event.requestContext.http.method`. For now: respond to `GET /alive` with `200` and empty body, everything else with the Bitwarden JSON 404 envelope `{"Message":"Not found.","ModelState":{},"ValidationErrors":[]}` (content-type `application/json`). Log `requestId` from `event.requestContext.requestId` on every call.
    - `src/router.ts`: minimal `match(method, path, routes)` — routes is a list of `{method, pattern, handler}` where pattern supports exact paths and `:param` segments (Phase 2 will need `/api/ciphers/{id}` style); return `{handler, params}` or 404-envelope. Priority: exact match wins over param match. 40 lines max, no dependencies.

    Rewrite `test/stack.test.ts` to assert the new resources (use CDK `Template.fromStack` + `hasResourceProperties`, NOT snapshots of the old stack): DynamoDB table present with on-demand billing mode; lambda present with `Runtime: nodejs22.x` (CDK property representation — use `hasResourceProperties("AWS::Lambda::Function", {Runtime: "nodejs22.x"})` or the NodejsFunction runtime value after `app.synth()`); HttpApi present; CloudFront distribution with 5 API path behaviors (`/api/*`, `/identity/*`, `/icons/*`, `/alive`, `/now`) and default static origin.

    Add `test/router.test.ts`: exact vs param precedence, missing route → null, param extraction.
  </verify>
  `npm test` green (jest covers test/*.test.ts). `npm run synth` green.
  <done>handler+router exist, all tests pass, stack assertions cover every new resource type.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` both green
- No EFS/Docker/backup code or references anywhere in lib/bin/test/cdk.json
- CDK template contains: VaultTable (on-demand, PITR), 3 buckets, nodejs22 lambda, HttpApi catch-all, CloudFront with OAC + 5 API behaviors
</verification>

<success_criteria>
- Repo is 100% serverless-native; any `docker` or `efs` mention is only in old docs (README fixed in Plan 03)
- Single-stack synth is offline-reproducible (no context lookups)
- Deployment-ready: `cdk deploy` can run (actual deploy happens in Plan 03)
</success_criteria>

<output>
After completion, create `.planning/phases/01-serverless-skeleton/01-SUMMARY.md`
</output>