---
phase: 02-identity-auth
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [package.json, lib/vaultwarden-stack.ts, src/store.ts, src/crypto.ts, src/router.ts, src/handler.ts, src/errors.ts, src/endpoints/identity.ts, test/stack.test.ts, test/crypto.test.ts, test/endpoints-auth.test.ts, test/router.test.ts]
autonomous: true

must_haves:
  truths:
    - "Register (both /identity and /api paths) creates a user item and answers 200 {}; signups closed when SIGNUPS_ALLOWED != true"
    - "Both prelogin routes return kdfConfig + legacy kdf fields; unknown email returns server defaults, never 404"
    - "npm test green; all password/key comparisons are constant-time"
  artifacts:
    - "src/store.ts (DynamoDB store interface + impl, GSI1 email lookup)"
    - "src/crypto.ts (token gen, PBKDF2 wrap, constant-time compare)"
    - "src/endpoints/identity.ts (register + prelogin)"
  key_links:
    - "store GSI1 (EMAIL#{email}) → PROFILE item → login path"
    - "handler body parsing (form or JSON, base64 aware) feeds identity endpoints"
---

<objective>
Create the storage + crypto layer and the registration/prelogin surface: the half of auth that needs no sessions yet.

Purpose: land the exact vaultwarden hash scheme, the table layout (GSI1 email index), and the two prelogin variants before the token machinery lands in Plan 02.
Output: register+prelogin endpoints, store/crypto modules, table GSI, all unit-tested with an in-memory store.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/research/API-SURFACE.md (§1.3, §1.4, §2.2)
@.planning/research/PITFALLS.md (§1.1, §1.2, §1.6, §1.9)
@.planning/research/ARCHITECTURE.md (§3.1, §5)
@src/handler.ts
@src/router.ts
@src/errors.ts
@lib/vaultwarden-stack.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Table GSI + runtime deps</name>
  <files>lib/vaultwarden-stack.ts, lib/vaultwarden-stack.ts test/stack.test.ts, package.json</files>
  <action>
    Add to `VaultTable`: `globalSecondaryIndexes: [{ indexName: 'GSI1', partitionKey: {name:'GSI1PK', type:STRING}, sortKey: {name:'GSI1SK', type:STRING} }]` (email lookup for prelogin/login; see ARCHITECTURE §3.4). Update `test/stack.test.ts` to assert GSI1 exists.

    Add runtime dependencies (first ones in the project): `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (latest; the Lambda is not installed with esbuild side-effects — `aws_lambda_nodejs.NodejsFunction` bundles them). Run `npm install`. These are RUNTIME deps (the store uses them); devDeps unchanged.
  </verify>
  `npm run synth` green; template contains an AWS::DynamoDB::Table with a GlobalSecondaryIndex named GSI1; `npm install` clean; `tsc --noEmit` green.
  <done>GSI1 wired and asserted; aws-sdk runtime deps installed (bundled by the existing NodejsFunction).</done>
</task>

<task type="auto">
  <name>Task 2: crypto + store modules</name>
  <files>src/crypto.ts, src/store.ts</files>
  <action>
    `src/crypto.ts` (node:crypto only, zero deps):
    - `newToken()` → 32 random bytes base64url (access/refresh/session tokens, crypto.randomBytes).
    - `newUuid()` → random UUID v4 (node crypto.randomUUID).
    - `hashPassword(secret: Buffer, salt: Buffer, iterations: number)` → PBKDF2-SHA256, 64-byte output — this is the server-side wrap vaultwarden applies on top of the client's hash (crypto.rs `hash_password`; `password_iterations` default 600_000, verified at execution time against vaultwarden main `src/config.rs` `password_iterations`).
    - `verifyPassword(secret, salt, stored, iterations)` → recompute + `crypto.timingSafeEqual` (vaultwarden `verify_password_hash`).
    - `ctEq(a, b)` → constant-time string compare (used for recovery codes later).
    - Export `DEFAULT_KDF = { type: 0 (PBKDF2-SHA256), iterations: 600_000, memory: null, parallelism: null }`.

    `src/store.ts`:
    - `interface Store` — the ONLY way endpoints touch data: `getUserByEmail(email)`, `getUser(userId)`, `putUser(user)`, plus (unused this plan but committed to the interface for Plan 02): `upsertDevice`, `getDevice`, `putSession`, `getSession`, `deleteSession`, `countFailedLogins(ip)`, `recordFailedLogin(ip)`, `clearFailedLogins(ip)`. Types: `UserItem {pk: "USER#{id}", sk: "PROFILE", id, email, passwordHash: Uint8Array (base64 in DDB), salt: base64, passwordIterations, kdfType, kdfIterations, kdfMemory?, kdfParallelism?, securityStamp, akey, privateKey, publicKey, name, enabled, premium, createdAt}`.
    - `class DynamoStore implements Store` — `DynamoDBDocumentClient` (from lib-dynamodb), table name env `VAULT_TABLE` (stack must set it — add `VAULT_TABLE: this.table.tableName` to the Lambda env in the stack; the grant already exists via Plan 01's read grant — widen it: `grantReadWriteData` now that sessions/rate items are written).
    - `class MemoryStore implements Store` — in-memory Map implementation used by unit tests (keep in store.ts until tests prove it insufficient; it will be deleted when a DDB integration test appears in Phase 3's smoke phase).
    - GSI1 lookup: `query({IndexName:'GSI1', KeyConditionExpression:'GSI1PK = :pk', ExpressionAttributeValues:{':pk': 'EMAIL#'+email}})` → PROFILE item carries `userId` (ARCHITECTURE §3.1).
    - Error convention: return `null` for missing (never throw for absent rows); let the caller decide 404/400.
  </verify>
  `tsc --noEmit` green. `node -e` smoke via ts-node: `hashPassword` roundtrip verifies true, wrong secret false, ctEq('a','a') true / ctEq('a','b') false. MemoryStore: putUser/getUserByEmail roundtrip (email case-insensitive → lowercase at write), missing → null.
  <done>crypto primitives + Store interface + both impls exist and are unit-covered by Task 4's tests.</done>
</task>

<task type="auto">
  <name>Task 3: register + prelogin endpoints, body parsing</name>
  <files>src/handler.ts, src/router.ts, src/errors.ts, src/endpoints/identity.ts</files>
  <action>
    Handler plumbing (the Phase-1 `// ponytail:` note expires here):
    - Body parsing in `createHandler` context: `parseBody(event)` → `{form?: URLSearchParams, json?: any}` — URL-encoded when `content-type` is form, JSON otherwise; decode `event.body` per `event.isBase64Encoded` (Buffer.from(base64).toString()).
    - `createHandler(routes, deps)` — deps `{store}` passed to route handlers as second arg; `Route.handler` signature becomes `(params, ctx) => Promise<Result> | Result` where `ctx = { store, body }, bodyJson, bodyForm }`. Update router type + all existing callers/tests with the new signature (endpoints/misc.ts handlers ignore ctx).
    - `src/endpoints/identity.ts`:
      - `POST /identity/accounts/register` AND `POST /api/accounts/register` (same handler, both paths — pitfall 1.9; accept unknown fields, never reject on extras):
        - if `env.SIGNUPS_ALLOWED !== 'true'` → 403 Bitwarden envelope `{"Message":"Registration is disabled."}`.
        - fields: `email`, `masterPasswordHash` OR `masterPasswordAuthentication.{hash, kdf, salt}`, `key`, `masterPasswordHint`, `name`, `keys:{publicKey, privateKey}`, plus org-invite fields IGNORED this phase (accept, store nothing).
        - Preconditions: email valid (contains '@'), hash present (one of the two shapes — prefer `masterPasswordAuthentication.hash` when both), duplicate email → 400 `{"Message":"An account with this email already exists."}`.
        - Store: `passwordHash = hashPassword(Buffer.from(clientHash, 'base64'), salt=random 64 bytes, 600_000)`, `passwordIterations: 600_000`, `kdfType/iterations/memory/parallelism` from `masterPasswordAuthentication.kdf` when sent else DEFAULT_KDF, `securityStamp: newUuid()`, `akey: key`, `keys` verbatim, `email` lowercased, `premium: true` (decision 2.10: fake premium — self-hosted expectation).
        - Respond `200 {}` (never 204 — pitfall 2.5).
      - `POST /identity/accounts/prelogin` + `POST /identity/accounts/prelogin/password` (pitfall 1.1: BOTH forever, same handler) AND `POST /api/accounts/prelogin` (legacy duplicate on /api):
        - body `{email}` → GSI1 lookup:
          - found: `{kdf: kdfType, kdfIterations, kdfMemory, kdfParallelism, kdfSettings: {kdfType, iterations, memory, parallelism}, salt: null}` — kdfConfig-AND-legacy dual emit (pitfall 1.2); `kdfSettings` keyed by the account's actual algorithm.
          - not found: server defaults (DEFAULT_KDF + kdfSettings), NEVER 404 (pitfall 1.1).
    - `src/errors.ts`: add `badRequest(message)` (400) helper.
  </verify>
  `npm test` green (new tests from Task 4). ts-node smoke: register with signups open → 200 {}; repeat email → 400; prelogin known email → exact kdfConfig shape; unknown email → defaults; both prelogin paths respond; `/api/accounts/register` duplicate of identity.
  <done>Register (2 paths) + prelogin (3 paths) live; parsing handled; signups gate works.</done>
</task>

<task type="auto">
  <name>Task 4: tests</name>
  <files>test/crypto.test.ts, test/endpoints-auth.test.ts, test/router.test.ts, test/handler.test.ts</files>
  <action>
    - `test/crypto.test.ts`: hashPassword roundtrip (right true, wrong false), iterations change → false, ctEq logic, newToken unique + base64url-safe charset.
    - `test/endpoints-auth.test.ts` (uses `createHandler(routes, {store: new MemoryStore()})`):
      - register success → user in store, store.hash para 600k, duplicate → 400 envelope exact Message, signups disabled env → 403, masterPasswordAuthentication shape preferred.
      - prelogin known → kdfConfig + legacy fields exact; unknown → defaults; both routes + /api/accounts/prelogin respond 200 (NOT 404).
    - Update `test/router.test.ts` + `test/handler.test.ts` for the new `(params, ctx)` signature (existing assertions unchanged).
  </verify>
  `npm test` fully green; `tsc --noEmit` green.
  <done>Every endpoint behavior asserted; no code path is untested for auth-start.</done>
</task>

</tasks>

<verification>
- `npm test` + `npm run synth` green
- Register/prelogin shape assertions hold for: legacy and new prelogin paths, kdfConfig+legacy dual emit, GSI1 email roundtrip
- No plaintext secrets in the user item: passwordHash is PBKDF2-wrapped, salt random per user
</verification>

<success_criteria>
- Account creation works end-to-end against the store; prelogin never 404s
- All password comparisons constant-time
- Wave 1 complete: Plan 02 can land token issuance on top of this store
</success_criteria>

<output>
After completion, create `.planning/phases/02-identity-auth/01-SUMMARY.md`
</output>