# Phase 5 SUMMARY — Organizations & Collections

## What shipped
- **Plan 01 — org + collection foundation** (commit 8437101, 120 tests): OrganizationItem/OrgUserItem/CollectionItem + full store layer (Dynamo + Memory), org CRUD + keys endpoints, collections CRUD, sync `profile.organizations` + `collections`. Owner membership (status 2, type 0) + optional first collection at org create.
- **Plan 02 — members + policies** (commit 5351d4a, 124 tests): invite/reinvite with no-email accept tokens (response relays `accessToken` per invite — extension vs Bitwarden's empty body), roles + last-owner guards, revoke/restore, bulk delete, public-keys, accept endpoint binding invite → account, register `orgInviteToken` binding (bad token leaves no orphan account), policies CRUD (`ORG#{orgId}#POLICY#{type}`) + `sync.policies`.
- **Plan 03 — sharing + accept page** (commits 3a86e03, 023be83, 126 tests): `PUT/POST /api/ciphers/{id}/share`, `/admin`, `/collections` + `/collections_v2`, `GET /api/ciphers/organization-details`, union read model `listCiphersForUser` (personal + accessible-collection org ciphers; owner/admin see all org collections), ORGCOLL link rows for cipher↔collection, org-delete cascades ciphers + attachment prefixes, static `accept.html` (client-side SHA-256→b64 hash, registers with orgInviteToken), BucketDeployment covers `static/`, e2e-vault.sh step 14, README no-email invite docs.

## Key decisions
- Member row key = `ORGUSER#{orgId}#{id}` where id = user id once bound, invite uuid while status 0; invited rows GSI1 `INVITE#{token}`, bound rows `USERORGS#{userId}`.
- Accept and register-with-token both confirm immediately (status 2) — no email means the token IS the auth; collection default "confirmed members" filter stays consistent.
- Org cipher visibility is collection-driven: a cipher in zero collections is orphaned (hidden from org vault) — matches vaultwarden.
- Empty collection `users` array = open to all members (Bitwarden semantic); collectionCreate snapshots "all confirmed members" at creation for the no-users case.

## Owner handoff (deploy + live checks)
1. `npm run webvault && npx cdk deploy --context vaultwarden:signupsAllowed=true`
2. `bash scripts/e2e-auth.sh https://vaultwarden.free-bert.online`
3. `bash scripts/e2e-vault.sh https://vaultwarden.free-bert.online` (now includes org step 14: org → invite → member register w/ token → share → member sync)
4. Redeploy `signupsAllowed=false`
5. Human web-vault check: org console with two accounts (owner + invited member), invite via surfaced token link, share a cipher to a collection, org vault view + member sees it, policy toggle shows in member sync.

## Skipped (with note)
- Groups (UI-only in admin console; `useGroups: true` already relayed), billing stubs, org export, reset-password enrollment. Revisit if the UI demands.
- Org cipher trash is soft-delete only via the org vault UI paths we have; purge stays personal.
