---
phase: 01-serverless-skeleton
plan: 03
type: execute
wave: 3
depends_on: [01, 02]
files_modified: [scripts/fetch-webvault.sh, package.json, .gitignore, lib/vaultwarden-stack.ts, README.md]
autonomous: false

must_haves:
  truths:
    - "A single `cdk deploy` produces the stack; the output includes the CloudFront URL"
    - "Opening the CloudFront URL in a browser shows the Bitwarden Web Vault login page"
    - "GET /alive, /now, /api/version, /api/config respond through the CloudFront domain"
    - "The web vault talks to the SAME origin (no CORS anywhere)"
    - "README documents the serverless deploy path, not Docker"
  artifacts:
    - "scripts/fetch-webvault.sh (pinned web vault artifact)"
    - "static/webvault/ contents (git-ignored)"
    - "BucketDeployment construct in the stack"
    - "Rewritten README.md"
  key_links:
    - "CloudFront default behavior → web vault bucket (OAC) serves index.html"
    - "CloudFront /api/* + /identity/* behaviors → API Gateway → Lambda (Plan 02 endpoints)"
    - "fetch-webvault.sh pin + sha256 → reproducible web vault artifact"
---

<objective>
Ship the skeleton: deploy the Web Vault static build, deploy the full stack to AWS, verify the boot endpoints through CloudFront, and rewrite the README to reflect the serverless world.

Purpose: this is the phase's end state — a real deployed URL where the web vault boots. Everything from Phase 2 on deploys into this.
Output: deployed stack + verification results + honest docs.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@lib/vaultwarden-stack.ts
@cdk.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Web vault artifact fetch script + gitignore</name>
  <files>scripts/fetch-webvault.sh, package.json, .gitignore</files>
  <action>
    Create `scripts/fetch-webvault.sh` (bash, executable):
    - Top of file: `PINNED_VERSION=""` — the executor MUST fill this with the latest release of https://github.com/dani-garcia/bw_web_builds (the vaultwarden-maintained web vault builds; check via GitHub API `latest` release during execution, e.g. `curl -s https://api.github.com/repos/dani-garcia/bw_web_builds/releases/latest`).
    - Downloads `<PINNED_VERSION>.zip` from the same GitHub repo to a temp dir, verifies the sha256 against the release's published checksum if present (or prints the computed sha256 for the first run), extracts into `static/webvault/`.
    - Deterministic: re-running with the same PINNED_VERSION must produce identical output (verify sha256 before extracting; fail loudly on mismatch).
    - Print the deployed version on success.
    - Update `.gitignore`: add `static/` (downloaded artifact, not source).
    - Update `package.json` scripts: add `"webvault": "bash scripts/fetch-webvault.sh"`.
  </verify>
  `bash scripts/fetch-webvault.sh` completes; `static/webvault/index.html` exists; `git status` shows no unintended files.
  <done>Script pinned+verified, artifact reproducible, static/ git-ignored.</done>
</task>

<task type="auto">
  <name>Task 2: BucketDeployment + full deploy + smoke tests</name>
  <files>lib/vaultwarden-stack.ts</files>
  <action>
    Add to the stack: `aws_s3_deployment.BucketDeployment` — source `static/webvault`, destination the static bucket, `prune: true`, distribution invalidation for `/*` paths (so new web vault versions invalidate automatically; wire via `distribution: this.distribution` if the construct supports it, else a `--paths "/*"` invalidation).

    Then deploy (this is an actual AWS deployment — aws credentials must be present in the environment; region/account resolution already in `bin/vaultwarden.ts`):
    1. `npm run synth` — must pass offline.
    2. `npx cdk deploy` — expect ~10 min (CloudFront propagation).
    3. Smoke tests against the deployed CloudFront URL (from cdk output `Outputs.{StackName}.CloudFrontUrl` or construct the domain `https://vaultwarden.free-bert.online` from context):
       - `curl -s -o /dev/null -w "%{http_code}" <url>/` → 200
       - `curl -s <url>/` contains `<title>` with Bitwarden web vault content
       - `curl -s <url>/alive` → 200/empty
       - `curl -s <url>/now` → 200 ISO date
       - `curl -s <url>/api/version` → 200 version string
       - `curl -s <url>/api/config` → 200 JSON with `environment.featureFlags`
       - `curl -s <url>/identity/connect/token -X POST` → 404 envelope JSON (not a 500, not a CF error page) — proves the pitfall-1 posture (identity routes answered by us, not by the cache)
    All of the above THROUGH the custom domain if configured (same-origin verification).
  </verify>
  All 7 curls pass against the deployed URL. `npx cdk deploy` output recorded.
  <done>Stack deployed; web vault served; boot endpoints live through CloudFront on the custom domain.</done>
</task>

<task type="checkpoint:human-verify">
  <name>Task 3: Human verification + README rewrite</name>
  <files>README.md</files>
  <action>
    Rewrite `README.md` completely (it is 640 lines of Docker/EFS operation docs — replace, don't patch):
    - What this is: custom Bitwarden-compatible server, serverless-native (Lambda + DynamoDB + S3 + API Gateway + CloudFront). Link PROJECT.md + .planning/.
    - Architecture: 6-line ASCII diagram (CloudFront → S3 static / API GW → Lambda → DynamoDB + S3 attachments).
    - Roadmap status: phase 1 done (skeleton), phase 2 next. List what works TODAY (web vault boots, alive/now/version/config) and what doesn't yet (auth — everything else).
    - Prerequisites: Node 24, npm, AWS creds + DEFAULT_ACCOUNT/DEFAULT_REGION via .env (keep existing resolution), NO container runtime (colima instructions deleted — celebrate this), NO Python venv (backup lambda gone).
    - Deploy: `npm ci`, `npm run webvault`, `npx cdk deploy`; update instructions for `vaultwarden:domain`/`vaultwarden:certificateArn` context keys.
    - Verification: the curl smoke list from Task 2 as a copy-paste block.
    - Backup/restore: DynamoDB PITR (table retains) + note that restore is a phase 7 artifact (runbook skeleton only).
    - Cost table: rewrite honestly (DynamoDB on-demand ~$0.00 solo, S3 cents, Lambda free tier, CloudFront free tier ~$0 — keep CostGuard alert note).
    - Delete from the repo: `docs/superpowers/` old designs are historical — leave them (no deletion), just stop referencing.

    Then STOP and hand verification to the user (checkpoint): present the URL and ask them to open it in a browser and confirm the Bitwarden Web Vault login page renders. If they report a problem, fix what they describe.
  </verify>
  README has no Docker/colima/EFS/SQLite content (grep). User confirms web vault login page renders at the deployed URL.
  <done>README honest + user-verified web vault boot. Phase 1 success criteria met.</done>
</task>

</tasks>

<verification>
- Phase success: CloudFront URL → web vault login page renders (human-verified), boot endpoints 200, identity 404-envelope (not CF error)
- `npm test` green; `cdk deploy` single-shot
</verification>

<success_criteria>
- Phase 1 (ROADMAP): `cdk deploy` → CloudFront serves web vault; `/alive` 200; zero containers; Docker bits gone; `npm test` green — ALL MET
</success_criteria>

<output>
After completion, create `.planning/phases/01-serverless-skeleton/03-SUMMARY.md`
</output>