---
phase: 08-emergency-access
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/store.ts, src/endpoints/emergency-access.ts, src/endpoints/identity.ts, src/handler.ts, static/ea-accept.html, test/emergency-access.test.ts, e2e-vault.sh, .planning/STATE.md]
autonomous: true

must_haves:
  truths:
    - "EmergencyAccessItem: pk EMERG#{grantorId}#{itemId}, sk EMERG; itemId = uuid fixed at invite; status 0 invited|1 accepted|2 confirmed|3 initiated|4 approved; token = accept token; grantee keys (encryptedPrivateKey, publicKey) land at accept; encryptedKey (grantor vault key, grantee-pubkey-encrypted) lands at confirm"
    - "Invite without email: POST /api/emergency-access/invite {email, type, waitTimeDays} → 200 {token, object:'emergencyAccessGranteeDetails'} — token surfaced in response (no-email mechanism, mirrors org invites)"
    - "Accept paths: authed POST /api/emergency-access/{id}/accept {token, encryptedPrivateKey, publicKey} (existing user) AND register with emergencyAccessToken + emergencyAccessId binds straight to the item (static page flow)"
    - "Access flow: initiate (grantee, status 2, waitTimeDays elapsed) → approve|reject (grantor) → view (grantee, ciphers + encrypted Key) → takeover (grantee: full issueSession as the GRANTOR account) → password {newMasterPasswordHash, key} resets the grantor's password+akey, status back to 2"
    - "Lists: GET /api/emergency-access/trusted (grantor view → granteeDetails), GET /api/emergency-access/granted (grantee view → grantorDetails); PUT|POST /{id} update type/waitTimeDays; DELETE|POST /{id}/delete; POST /{id}/reinvite regenerates token (status 0)"
    - "Policies during access: GET /api/emergency-access/{id}/policies → 200 {Data:[], Object:'listResponse'} (lazy: grantor org policies follow the orgs phase shape later)"
  artifacts:
    - "Full v1 emergency access: trust lifecycle + access flow + takeover + password reset, surfaced-token static page, tests"
  key_links:
    - "static/accept.html pattern (register with invite token) → new ea-accept.html"
    - "issueSession/authenticatedResponse in identity.ts reused for takeover session"
---

<objective>
Ship v1 emergency access end-to-end (MISC-05): trust lifecycle with surfaced tokens, access request flow, takeover session, password reset. Avatar stubs and account-misc are documented skips (web vault renders initials; profile.premium already true).
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/research/API-SURFACE.md (§2.7)
@.planning/REQUIREMENTS.md (MISC-05)
@src/endpoints/identity.ts (register + issueSession)
@static/accept.html
</context>

<tasks>

<task type="auto">
  <name>Task 1: emergency-access endpoints + store</name>
  <files>src/store.ts, src/endpoints/emergency-access.ts, src/handler.ts, src/endpoints/identity.ts</files>
  <action>
    - EmergencyAccessItem + store methods (put/getByGrantor/delete/listTrusted/listGranted); Dynamo + Memory
    - endpoints module: invite/reinvite/accept/confirm/update/delete/lists/initiate/approve/reject/view/takeover/password/policies
    - register: emergencyAccessToken + emergencyAccessId bind (status 0 → 1, store acc keys)
    - takeover reuses issueSession(grantorUser, granteeDeviceId) + authenticatedResponse
  </verify>
  jest: full lifecycle (invite → accept via both paths → confirm → initiate → approve → view → takeover → password) + auth guards (wrong grantor/grantee → 404/400)
  <done>EA endpoints live.</done>
</task>

<task type="auto">
  <name>Task 2: static page + wrap</name>
  <files>static/ea-accept.html, scripts/e2e-vault.sh, .planning/phases/08-emergency-access/01-SUMMARY.md, .planning/STATE.md</files>
  <action>
    - ea-accept.html: register with emergencyAccessId + emergencyAccessToken (mirror accept.html; BucketDeployment already ships static/)
    - e2e step 16: invite → token → register member → confirm → initiate → approve → view
    - 01-SUMMARY.md + STATE.md; avatar/premium/account-misc documented skips
  </verify>
  `bash -n` + full test suite green
  <done>Phase 8 wrapped.</done>
</task>

</tasks>

<verification>
- `npm test` + tsc green; e2e script syntax-valid
</verification>

<success_criteria>
- Web vault Settings → Emergency Access: invite with surfaced token, grantee registers via ea-accept.html, confirm, initiate → approve, grantee views/takes over the vault
</success_criteria>

<output>
After completion, update .planning/STATE.md, write the phase summary.
</output>