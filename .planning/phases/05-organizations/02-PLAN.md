---
phase: 05-organizations
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/endpoints/organizations.ts, src/endpoints/identity.ts, src/store.ts, src/handler.ts, test/organizations.test.ts, test/identity.test.ts]
autonomous: true

must_haves:
  truths:
    - "Members lifecycle: invite → member row status 0 (invited) with accessToken (uuid, surfaced in API response — no email); accept via register with orgInviteToken OR POST /api/organizations/{id}/users/{memberId}/accept {token, name?, key?}; confirm POST {key} sets status 2"
    - "Invite stores email + a membership row immediately; register(orgInviteToken) binds the existing row (by accessToken) to the new user id; accept-without-register path works when the account already exists"
    - "Roles: type 0 owner, 1 admin, 2 user, 3 manager — owner/admin manage members+collections; user/manager see only their collections"
    - "Policies: PolicyItem {pk ORG#{orgId}#POLICY#{type}, sk POLICY, type, enabled, data}; CRUD by type; sync.policies filled; register/org flows do NOT enforce (stored values returned, honoring = web vault side)"
  artifacts:
    - "members endpoints: invite/reinvite/accept/confirm/remove/list/edit/public-keys"
    - "register orgInviteToken binding"
    - "policy endpoints + sync.policies"
    - "test/organizations.test.ts extension"
  key_links:
    - "accept payload from web vault: POST /identity/accounts/register {email, ..., organizationUserId, orgInviteToken} or POST /api/organizations/{id}/users/{memberId}/accept {token}"
    - "reinvite regenerates accessToken; remove/leave drops the row"
---

<objective>
Member lifecycle (invite → accept → confirm), roles, and org policies CRUD — the pieces that make a two-user org real.
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.5 members/policies)
@src/endpoints/organizations.ts
@src/endpoints/identity.ts
@src/store.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: member CRUD + roles</name>
  <files>src/endpoints/organizations.ts, src/handler.ts</files>
  <action>
    - `POST /api/organizations/{id}/users/invite` {emails:[{email, type}]} → creates OrgUser rows (status 0, accessToken uuid); response 200 {}; **token surfacing: each invite returns {email, accessToken} in the response body** (no-email constraint, ORG-07; web vault shows the invite link from the response)
    - `POST /api/organizations/{id}/users/reinvite` {userIds} + `.../users/{memberId}/reinvite` → regenerate accessToken
    - `GET /api/organizations/{id}/users` (?search=) → [{id, email, status, type, name?, revisionDate, object:'organizationUser'}] + `.../users/mini-details` (id/email/status/type)
    - `PUT|POST .../users/{memberId}` {type, collections?} → update role
    - `DELETE .../users/{memberId}` + `POST .../{memberId}/delete` + `DELETE .../users` {userIds} → drop row + USERCOLL rows
    - `PUT .../users/{memberId}/revoke` + `.../restore` → status 1↔2 toggling (revoke sets status 1, restore re-confirms)
    - `POST /api/organizations/{id}/users/public-keys` {userIds} → [{userId, publicKey}] (for share, plan 03)
    - Access guards: owner/admin only for invite/reinvite/confirm/remove/edit; owner-only for delete-org
  </verify>
  `npm test` green; smoke: invite → accept (existing account) → confirm → list shows confirmed; role change persists
  <done>Member lifecycle live.</done>
</task>

<task type="auto">
  <name>Task 2: accept flow + register binding</name>
  <files>src/endpoints/organizations.ts, src/endpoints/identity.ts</files>
  <action>
    - `POST /api/organizations/{id}/users/{memberId}/accept` {token, name?, organizationUserId?} → valid token + status 0 → status 1 (accepted); binds userId from authenticated caller; regenerates nothing; invalid/used token → 400
    - register: accept `orgInviteToken` + `organizationUserId` (or email match on the invited row); after user creation, bind row(s): status 0 → 1 by token match; then (per VW) the client confirms separately
    - If the invited email's account already exists and no register happens: accept endpoint above is the path (web vault sends it authenticated)
  </verify>
  `npm test` green; smoke: fresh account register-with-token binds membership
  <done>Invite-accept binding live.</done>
</task>

<task type="auto">
  <name>Task 3: policies CRUD + sync</name>
  <files>src/endpoints/organizations.ts, src/endpoints/accounts.ts, src/store.ts</files>
  <action>
    - `GET /api/organizations/{id}/policies` → [{id, organizationId, type, data, enabled, object:'policy'}]; `GET .../policies/{polType}` single
    - `PUT .../policies/{polType}` {enabled, data} (admin) → upsert, 200 {}
    - sync.policies = all orgs' policies (stored values; honoring is client-side per vaultwarden)
    - skip: `policies/token` + master-password stub (web vault register-org-invite gate) unless trivial
  </verify>
  `npm test` green; smoke: set policy → sync shows it → update → reflected
  <done>Policies CRUD live.</done>
</task>

</tasks>

<verification>
- two-account org: invite → second account register-with-token → confirm → member list statuses correct; policy set appears in both syncs
</verification>

<success_criteria>
- Web vault org console: invite shows token, accept works for a second account, roles editable, policies storable
</success_criteria>

<output>
After completion, commit plan 02, then execute plan 03 (share + org vault read model + accept page + e2e + wrap).
</output>
