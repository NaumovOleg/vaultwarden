---
phase: 05-organizations
plan: 01
type: execute
wave: 1
depends_on: [04]
files_modified: [src/store.ts, src/endpoints/organizations.ts, src/endpoints/collections.ts, src/endpoints/accounts.ts, src/handler.ts, test/organizations.test.ts]
autonomous: true

must_haves:
  truths:
    - "OrganizationItem + OrgUserItem + CollectionItem rows; membership is the row (status 0=invited,1=accepted,2=confirmed, type 0=owner,1=admin,2=user,3=manager)"
    - "sync.organizations filled from user's org memberships (GSI1 USERORGS#{userId}); orgAbility = flat use* capability flags per org"
    - "sync.collections filled from accessible collections; collection JSON {id, organizationId, name, externalId, hidePasswords, readOnly, manage, revisionDate, object:'collectionDetails'}"
    - "Org keys: POST /api/organizations/{id}/keys {publicKey, privateKey, key} relayed verbatim; GET .../keys returns stored keys; GET .../public-key returns {publicKey}"
    - "Org create: POST /api/organizations {name, billingEmail?, key, keys:{publicKey,privateKey}, collectionName?} → creates org (owner membership confirmed) + optional first collection"
  artifacts:
    - "src/endpoints/organizations.ts (create, get, update, delete, keys, public-key, leave)"
    - "src/endpoints/collections.ts (list, details, create, update, delete)"
    - "sync integration: organizations + orgAbility + collections"
    - "test/organizations.test.ts"
  key_links:
    - "org rows: pk ORG#{orgId} sk ORG; membership: pk ORGUSER#{orgId}#{userId} sk ORGUSER (GSI1PK USERORGS#{userId}, GSI1SK ORGUSER)"
    - "collection rows: pk COLLECTION#{orgId}#{collectionId} sk COLLECTION, users:[{id,readOnly,hidePasswords}]; GSI1PK USERCOLL#{userId} per listed member"
    - "org cipher rows: pk CIPHER#{orgId}#{cipherId} (organizationId implied by pk prefix; read model in plan 03)"
---

<objective>
Org foundation: organization + collection storage and CRUD, sync integration so the web vault renders orgs/collections in the left rail (empty state fine).
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§2.5 organizations/collections)
@src/endpoints/accounts.ts
@src/store.ts
@src/handler.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: storage — OrganizationItem, OrgUserItem, CollectionItem</name>
  <files>src/store.ts</files>
  <action>
    - `OrganizationItem {pk ORG#{orgId}, sk ORG, id, name, billingEmail, key, keys:{publicKey,privateKey}, createdAt, revisionDate}`
    - `OrgUserItem {pk ORGUSER#{orgId}#{userId}, sk ORGUSER, orgId, userId, email, status, type, accessToken|null (invite token, plan 02), revisionDate}`; GSI1PK `USERORGS#{userId}`, GSI1SK 'ORGUSER'
    - `CollectionItem {pk COLLECTION#{orgId}#{collectionId}, sk COLLECTION, id, organizationId, name, externalId, hidePasswords, readOnly, manage, users:{id,readOnly,hidePasswords}[], revisionDate}`; GSI1PK `USERCOLL#{userId}` for each listed user
    - Store methods (Dynamo + Memory): putOrganization/getOrganization/listOrganizationsForUser (GSI1 USERORGS), putOrgUser/getOrgUser/listOrgUsers(orgId) (query pk prefix), putCollection/getCollection/listCollectionsForUser (GSI1 USERCOLL), listCollectionsForOrg (pk prefix), deleteCollection, deleteOrgUser, deleteOrganization (cascade rows + membership)
    - deleteUser cascade: ORGUSER + USERCOLL rows for the user
  </verify>
  `npm test` green
  <done>Storage layer live.</done>
</task>

<task type="auto">
  <name>Task 2: organization endpoints</name>
  <files>src/endpoints/organizations.ts, src/handler.ts</files>
  <action>
    - `POST /api/organizations` {name, billingEmail?, key, keys:{publicKey,privateKey}, collectionName?} → create org + owner OrgUser (status 2, type 0) + optional first collection (users: [owner], manage: true) → 200 {} (web vault then GETs the org)
    - `GET /api/organizations/{id}` → org JSON {id, name, billingEmail, key, keys, status, type (of viewer), enabled, use* flags, object:'organization'} (member-only, else 404)
    - `PUT|POST /api/organizations/{id}` {name?, billingEmail?} → 200 {}
    - `POST /api/organizations/{id}/keys` {publicKey, privateKey, key} → relay verbatim, 200 {}
    - `GET /api/organizations/{id}/keys` → {publicKey, privateKey, key}; `GET /api/organizations/{id}/public-key` → {publicKey}
    - `POST|DELETE /api/organizations/{id}/delete` (owner-only) → cascade org rows + collections + org ciphers (deletePrefix? no S3 prefix for ciphers; org cipher rows by pk prefix) → 200 {}; `POST /api/organizations/{id}/leave` → drop own membership
  </verify>
  ts-node smoke: create org → get → set keys → read keys → leave; delete cascades
  <done>Org CRUD live.</done>
</task>

<task type="auto">
  <name>Task 3: collection endpoints + sync</name>
  <files>src/endpoints/collections.ts, src/endpoints/accounts.ts, src/handler.ts</files>
  <action>
    - `GET /api/collections` (accessible, all orgs), `GET /api/organizations/{id}/collections` (+`/details` same shape), `GET .../collections/{colId}/details` — member-only access check
    - `POST /api/organizations/{id}/collections` {name, externalId?, users?: [{id, readOnly, hidePasswords}]} → create (members get their access rows updated); default users = all confirmed members
    - `PUT|POST .../collections/{colId}` {name?, externalId?, users?} → 200 {}; `DELETE .../collections/{colId}` + `POST .../{colId}/delete` → 200 {} (cascade USERCOLL rows)
    - sync: organizations (from memberships, orgAbility use* flags true set), collections (accessible), leave policies [] until plan 02
    - profile.organizations also filled (shared orgJson serializer)
  </verify>
  `npm test` green; sync smoke: org + collection visible to owner only
  <done>Collections CRUD + sync live.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- owner creates org → collection visible in web vault left rail; second user does not see it
</verification>

<success_criteria>
- Web vault: "New organization" creates org + first collection; collections CRUD works in admin console; sync renders orgs
</success_criteria>

<output>
After completion, commit plan 01, then execute plan 02 (members + policies).
</output>
