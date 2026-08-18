# Phase 7 — Hardening & Polish: SUMMARY

## What shipped

Plans 01–02, commits 70d3c2e, 63f77b6, dbee77d, + this wrap commit. 144 tests green, tsc clean.

- **Icons service** (`GET /icons/{host}/icon.png`): normalized host → cached S3 hit (24h client cache header) → miss: fetch `icons.bitwarden.net` upstream → store + serve; failures store an empty negative-marker object so broken hosts never re-fetch. `ICONS_BUCKET` env + Lambda grants wired. One route added to the existing `/icons/*` CloudFront → API path.
- **Equivalent domains** (`GET|PUT|POST /api/settings/domains`): global groups (subset mirrored from vaultwarden), per-user override persisted on `UserItem.domainsOverride`, validated body → 400 on garbage.
- **HIBP stub** (`GET /api/hibp/breach`): honest 404 (check unavailable), matching vaultwarden-without-proxy behavior; web vault degrades gracefully.
- **CloudWatch alarms**: Lambda Errors and API-GW 5XXError alarm via SNS → `vaultwarden:alertEmail`, gated like the budget (no email → no alarms, deploy-time warning).
- **Restore runbook** `docs/ops/backup-restore.md`: PITR restore to new table, repoint env, TTL re-add, attachments version recovery, smoke checklist. README got Backup + Monitoring sections.

## Key decisions

1. Icons negative caching (empty-object marker) — the alternative (no cache on failure) makes the web vault hammer the upstream on every vault render.
2. `hibpBreach` returns 404, not `[]` — `[]` would fraudulently claim "no breaches".
3. No formal SDK E2E harness — the bash `e2e-auth.sh` / `e2e-vault.sh` scripts are the established integration check; an SDK suite would duplicate them at higher maintenance cost (documented deviation from ROADMAP wording).
4. Errors alarm threshold ≥1 in a 5-min window, `treatMissingData: notBreaching` — a cold account doesn't page anyone.

## Owner handoff (run after deploy)

1. `bash scripts/e2e-vault.sh https://<domain>` — still green end-to-end.
2. Open web vault → any login item row → favicon appears (first load fetches upstream, then cached).
3. Settings → Equivalent domains: add `example.com` + `example.org` group → save → reload visible.
4. Reports → Exposed passwords: shows "check unavailable" (404), never a false "no breaches".
5. Trigger a 5xx (e.g. temporarily break an env var) → alarm email within ~5 min.
6. `config` dashboard: CloudWatch /aws/lambda/<name> logs show the request log lines.

## Known ceilings (ponytail-flagged)

- Single icon upstream (`icons.bitwarden.net`); failover ladder only if long-term outage.
- Global equivalent domains list is a subset (4 groups, cosmetic feature).
- No lifecycle rule on attachments bucket versions (unlimited retention) — add when cost shows up.