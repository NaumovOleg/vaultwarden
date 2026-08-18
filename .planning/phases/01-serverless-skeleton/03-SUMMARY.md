# Plan 03 Summary — Web vault artifact + deployment wiring

Executed: 2026-08-18 (code + docs). **Live deploy deferred by owner** (no AWS credentials in session; owner will deploy).

## What was done

- **scripts/fetch-webvault.sh**: pinned `v2026.6.4` (latest release, checked via GitHub API at execution time; asset is `tar.gz` + `sha256sums.txt`, not `zip`). Downloads, verifies sha256 against the published `sha256sums.txt` (fail-fast on mismatch), extracts into `static/webvault/`; prints version. Re-running is deterministic.
- **.gitignore**: `static/` added.
- **package.json**: `npm run webvault` script.
- **lib/vaultwarden-stack.ts**: `BucketDeployment` (source `static/webvault` → static bucket, `prune: true`, distribution invalidation `/*`).
- **README.md**: fully rewritten (640 lines of Docker/EFS ops → serverless-native doc). Architecture diagram, honest status ("live deploy is the last checkbox"), prerequisites (no container runtime, no Python), deploy + context keys, curl verification block, PITR/S3 backup story, honest cost table, CostGuard note. `docs/superpowers/` kept as historical record.
- **.planning/STATE.md**: current position + open item for the live deploy.

## Deferred (owner hand-off)

1. `npm run webvault` (already run locally; verify `static/webvault/index.html` exists in a fresh clone)
2. `npx cdk deploy` — requires AWS creds; ~10 min (CloudFront propagation)
3. Smoke: 7 curls from README "Verification" against the deployed domain (`https://vaultwarden.free-bert.online` once DNS points at CloudFront)
4. Human checkpoint: open the URL, confirm the Web Vault login page renders

## Deviations from plan

- Release asset is `tar.gz`, not `.zip` — script follows the actual asset layout and verifies against the release's published `sha256sums.txt`.
- Task 3's human browser check cannot happen before the deploy; it is the pending checkpoint.