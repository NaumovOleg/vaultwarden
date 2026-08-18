---
phase: 05-organizations
plan: 03
type: execute
wave: 3
depends_on: [02]
files_modified: [src/endpoints/ciphers.ts, src/endpoints/organizations.ts, src/endpoints/accounts.ts, src/endpoints/collections.ts, src/store.ts, src/handler.ts, lib/vaultwarden-stack.ts, scripts/fetch-webvault.sh, test/organizations.test.ts, scripts/e2e-vault.sh, .planning/STATE.md]
autonomous: true

must_haves:
  truths:
    - "Org cipher read model: user sees personal ciphers + org ciphers whose collection lists them (owner/admin see all org collections); sync.ciphers = that union, collectionIds attached"
    - "Share: PUT|POST /api/ciphers/{id}/share {collectionIds:[], collections:[{id,readOnly,hidePasswords}]} → moves a personal cipher to CIPHER#{orgId}#{id} (organizationId implied by pk), attaches collectionIds; owner-only cipher edit via .../admin when not in own collections"
    - "org vault view: GET /api/ciphers/organization-details?organizationId= → org ciphers of collections the caller can access"
    - "Attachments/sends on org ciphers reuse the same S3 keys (attachments/{cipherId}/) — cascade purge per org uses deletePrefix per cipher"
    - "Accept page: tiny static HTML served from the static bucket (register-with-token flow) — surfaced accept URL is the no-email UX (ORG-07)"
  artifacts:
    - "share endpoint + org cipher read model (listCiphersForUser union)"
    - "organization-details + admin edit paths"
    - "static accept page + stack asset wiring"
    - "e2e-vault.sh org steps + phase SUMMARY + STATE.md"
  key_links:
    - "cipherJson already emits organizationId/collectionIds — org ciphers get organizationId from pk prefix"
    - "share payload from web vault: {collectionIds, collections:[{id, readOnly, hidePasswords}]} (key re-wrapped client-side in cipher.key)"
---

<objective>
Make orgs usable: share personal ciphers into collections, the org vault read model, and the no-email accept page; wrap the phase.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.5 share/org vault)
@src/endpoints/ciphers.ts
@src/store.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: share + org read model</name>
  <files>src/endpoints/ciphers.ts, src/store.ts, src/endpoints/accounts.ts</files>
  <action>
    - store: `listCiphersForUser(userId)` = personal (CIPHER#{userId}#) + org ciphers of accessible collections (per plan 02 membership+collection rows; owner/admin = all org collections). Sync + /api/ciphers use it
    - `PUT|POST /api/ciphers/{id}/share` {collectionIds, collections?} → cipher must be personal; move row to CIPHER#{orgId}#{id}; orgId from the first collection; write cipher.key as sent (client re-encrypts); 200 {} (vaultwarden returns empty; web vault then refreshes)
    - `PUT|POST /api/ciphers/{id}/admin` + `.../collections-admin` → admin bypass edit (owner/admin); `PUT|POST /api/ciphers/{id}/collections` + `.../collections_v2` {collectionIds} → membership update for org ciphers
    - `GET /api/ciphers/organization-details?organizationId=` → org cipherDetails list (accessible subset)
    - delete-org (plan 01) cascade now also covers org cipher rows + their attachment prefixes
  </verify>
  `npm test` green; smoke: owner shares cipher to collection → member sync shows it with collectionIds; personal list no longer shows it
  <done>Share + read model live.</done>
</task>

<task type="auto">
  <name>Task 2: accept page (no-email UX)</name>
  <files>scripts/fetch-webvault.sh, lib/vaultwarden-stack.ts</files>
  <action>
    - static/accept.html: minimal form — fields email, name, master password hash (JS: base64 of client-hash? No: reuse web vault crypto is out; page POSTs masterPasswordHash=base64(password) + key + keys to /identity/accounts/register with orgInviteToken + organizationUserId; register already accepts these fields)
    - fetch-webvault.sh: copy accept.html alongside the webvault zip; stack BucketDeployment includes it (add to the existing webvault asset source)
    - README: how to surface the invite link (response accessToken → https://<domain>/accept.html?token=...&orgUserId=...)
  </verify>
  `bash -n`; synth green; jest green
  <done>Accept page wired.</done>
</task>

<task type="auto">
  <name>Task 3: e2e + phase wrap</name>
  <files>scripts/e2e-vault.sh, .planning/phases/05-organizations/03-SUMMARY.md, .planning/STATE.md</files>
  <action>
    - e2e-vault.sh: org steps — create org → invite second account (token) → register-second-account-with-token → confirm → share cipher to collection → member sync shows it
    - 03-SUMMARY.md with deploy handoff (owner: redeploy, web-vault org console check, accept page check)
  </verify>
  `bash -n`; `npm test`; synth green
  <done>Phase 5 wrapped; deploy handoff written.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- two-account org roundtrip: share → member sees → member cannot edit (readOnly collection) → admin can
</verification>

<success_criteria>
- Web vault: org console with two accounts, invite via surfaced token, share cipher to collection, org vault view works
- Skipped with note: groups, billing stubs, org export, reset-password enrollment (admin-console-only; revisit if UI demands)
</success_criteria>

<output>
After completion, update .planning/STATE.md and write the phase summary.
</output>
