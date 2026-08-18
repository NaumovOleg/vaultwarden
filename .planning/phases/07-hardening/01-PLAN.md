---
phase: 07-hardening
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/endpoints/misc.ts, src/endpoints/icons.ts, src/handler.ts, src/store.ts, lib/vaultwarden-stack.ts, test/icons.test.ts, .planning/STATE.md]
autonomous: true

must_haves:
  truths:
    - "Icons: GET /icons/{host}/icon.png — normalize host, fetch from https://icons.bitwarden.net/{host}/icon.png (vaultwarden's upstream), cache bytes in ICONS_BUCKET under icons/{host}/icon.png, serve cached on hit; failures → 404 + 1x1 transparent PNG (web vault renders placeholder, non-fatal)"
    - "GET /api/settings/domains — globalEquivalentDomains static list (vaultwarden's default 19 groups), user override honored when stored; PUT|POST /api/settings/domains {excludedGlobalEquivalentDomains, equivalentDomains} → stored on UserItem (domainsOverride), appears in sync too"
    - "GET /api/hibp/breach?username= — stub 404 (honest 'check unavailable'; vaultwarden errors when HIBP unconfigured — web vault degrades gracefully)"
    - "ICONS_BUCKET env wired in stack with read/write grant for the Lambda + existing /icons/* API origin"
  artifacts:
    - "icons lambda handler + S3 cache, settings/domains user override, hibp stub, tests, stack env"
  key_links:
    - "web vault boot: /api/config → vault row icons hit /icons; plain 404 causes repeated fetches — cache positive and negative"
---

<objective>
Ship the icons service (fetch+cache+failover), settings/domains user override, and the HIBP stub.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/research/API-SURFACE.md (§2.11)
@lib/vaultwarden-stack.ts (iconsBucket + /icons/* origin already exist)
@src/endpoints/misc.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: icons service</name>
  <files>src/endpoints/icons.ts, src/handler.ts, src/endpoints/misc.ts, lib/vaultwarden-stack.ts, test/icons.test.ts</files>
  <action>
    - host normalize: strip scheme/path, lowercase, reject non-host chars; port kept
    - cache key icons/{host}.png; S3 Get → hit: return bytes (Content-Type image/png, Cache-Control public, max-age=86400)
    - miss: fetch https://icons.bitwarden.net/{host}/icon.png (fetch with 10s signal, follow redirects)
      → 200 + image bytes → PutObject + serve; anything else → 404 + 1x1 PNG body
    - negative caching: failed fetch cached as EMPTY marker (icons/{host}.png empty object) for 1h — served as 404
    - stack: ICONS_BUCKET env + put/get/delete grants on icons bucket (Lambda needs Get on empty marker too — Get+Put+Delete on iconsBucket)
  </verify>
  jest: mock fetch — miss→upstream bytes cached; second hit→from cache (fetch call count); upstream 500→404+marker; negative marker → 404 without fetch
  <done>Icons live with cache + failover.</done>
</task>

<task type="auto">
  <name>Task 2: domains + hibp stub</name>
  <files>src/endpoints/misc.ts, src/endpoints/accounts.ts, src/store.ts, src/handler.ts, test/icons.test.ts</files>
  <action>
    - UserItem.domainsOverride: {excludedGlobalEquivalentDomains: number[], equivalentDomains: string[][]} | null
    - GET /api/settings/domains → {object:'domains', equivalentDomains: override??[], globalEquivalentDomains: [...excluded? none:15 defaults...], excludedGlobalEquivalentDomains: []}
      shape per vaultwarden domains.rs: global list of [groupname arrays] — use minimal 2 groups to keep test honest + note
    - PUT|POST /api/settings/domains → store override, return same shape (validated: arrays)
    - GET /api/hibp/breach → 404 (stub)
  </verify>
  jest: PUT override → GET reflects; hibp 404; tsc green
  <done>Domains override + hibp stub live.</done>
</task>

</tasks>

<verification>
- `npm test` + tsc green; icons negative/positive cache covered by mocked fetch
</verification>

<success_criteria>
- Web vault rows show favicons after first load; Equivalent domains edit persists; breach report shows unavailable-not-breached
</success_criteria>

<output>
After completion, update .planning/STATE.md.
</output>