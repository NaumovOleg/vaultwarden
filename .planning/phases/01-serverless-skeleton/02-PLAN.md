---
phase: 01-serverless-skeleton
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [src/handler.ts, src/router.ts, src/errors.ts, src/endpoints/misc.ts, test/router.test.ts, test/endpoints.test.ts, test/handler.test.ts]
autonomous: true

must_haves:
  truths:
    - "GET /alive returns 200 with an empty body"
    - "GET /now returns an ISO-8601 UTC timestamp"
    - "GET /api/version returns the configured version string"
    - "GET /api/config returns a Bitwarden-shaped config object (feature flags)"
    - "Unknown routes return the Bitwarden JSON 404 envelope, never a Lambda error or blank 404"
  artifacts:
    - "src/errors.ts (Bitwarden error envelope)"
    - "src/endpoints/misc.ts (alive/now/version/config)"
    - "test/endpoints.test.ts, test/handler.test.ts"
  key_links:
    - "handler → router → endpoint functions (no dead code paths)"
    - "router matches API Gateway rawPath strings"
---

<objective>
Implement the Lambda boot endpoints with the Bitwarden-compatible response envelope and a testable router.

Purpose: every client (and the web vault) boots by hitting `/api/config`, `/api/version`, `/now`, `/alive` — these must be right before Phase 2 can add auth.
Output: working endpoints with unit tests.
</objective>

<execution_context>
@./.claude/get-shit-done/execution-context.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/research/API-SURFACE.md
@.planning/research/PITFALLS.md
@src/handler.ts
@src/router.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Error envelope + endpoint implementations</name>
  <files>src/errors.ts, src/endpoints/misc.ts</files>
  <action>
    Create `src/errors.ts`:
    - `class BitwardenError extends Error` with `status: number`, `message`, optional `modelState: Record<string, string[]>`, optional `validationErrors: unknown[]`.
    - `toErrorEnvelope(err: BitwardenError): string` → JSON in Bitwarden's exact shape: `{"Message":"...","ModelState":{},"ValidationErrors":[]}` — `ModelState` and `ValidationErrors` present as empty collections unless populated (never omit keys).
    - `notFound()` helper → 404 with Message `"Not found."`.
    - Never throw raw system errors to the client: handler catches all and maps unknown errors to `500 {"Message":"Internal server error."}` (log the real error server-side).

    Create `src/endpoints/misc.ts`:
    - `GET /alive` → `200`, body `""` (vaultwarden returns an empty 200 — exactly this, not JSON).
    - `GET /now` → `200` body `new Date().toISOString()` (no content-type JSON — plain body is fine).
    - `GET /api/version` → `200`, body = `process.env.VERSION ?? "1.0.0-dev"` (plain text, no quotes).
    - `GET /api/config` → `200` JSON. Mirror vaultwarden's shape: fetch https://raw.githubusercontent.com/dani-garcia/vaultwarden/main/src/api/config.rs (webfetch) and replicate the response fields with empty/safe defaults (feature flags object, versioning object/fields as in source). At minimum the response must contain `environment.featureFlags` as an object and `environment` serialized per vaultwarden source. `versioning` from `process.env.VERSION`. All responses set `Content-Type: application/json; charset=utf-8`.
  </verify>
  `npm test` — `test/endpoints.test.ts` (add in Task 2) green. Direct invoke via `ts-node -e` calling each endpoint handler with a fake event returns the exact bodies above.
  <done>4 endpoints exist with exact bodies; errors/envelope helpers present and used by handler.</done>
</task>

<task type="auto">
  <name>Task 2: Router hardening + handler wiring + tests</name>
  <files>src/handler.ts, src/router.ts, test/router.test.ts, test/endpoints.test.ts, test/handler.test.ts</files>
  <action>
    In `src/router.ts` (built in Plan 01): keep the 40-line `match()`; export `Route` type; ensure pattern params are URL-decoded; methods matched as raw strings (`GET`, `POST`, etc).

    In `src/handler.ts`: wire router → registered routes from `src/endpoints/misc.ts` (+ the shell that Plan 01 left — replace its inline `if` with the router). Flow:
    1. Extract `method` (`event.requestContext.http.method`) and `path` (`event.rawPath`).
    2. `match()` → not found → 404 envelope JSON.
    3. Handler throws → `BitwardenError` → its envelope; anything else → log `error` + 500 envelope.
    4. Always log `{requestId, method, path, status}` at `info`.
    5. Set `Content-Type: application/json; charset=utf-8` on JSON responses (alive/version/now keep plain).
    - Note for later phases (do NOT implement now): `event.body` is base64-encoded when `event.isBase64Encoded` — the executor of Phase 2 will need a `parseBody()` helper. Just leave a `// ponytail:` comment in handler.ts noting real body parsing starts in Phase 2.

    Tests (all in `test/`): `router.test.ts` — exact match wins over param match, params extracted+decoded, unknown → null. `endpoints.test.ts` — alive/now/version/config exact bodies (config: assert `environment.featureFlags` is an object and `versioning` key exists). `handler.test.ts` — unknown path → 404 envelope shape `{Message, ModelState, ValidationErrors}`; known path → 200; a throwing handler → 500 envelope (inject by registering a bogus route in the test or mocking).
  </verify>
  `npm test` fully green; `ts-node -e` smoke: invoke handler with `{rawPath:"/api/config", requestContext:{http:{method:"GET"}}}` → 200 JSON with `environment.featureFlags`.
  <done>All tests green; handler uses router; every response is one of: plain bodies (alive/now/version), Bitwarden envelope (errors), config JSON.</done>
</task>

</tasks>

<verification>
- `npm test` green (new test files run under jest roots `test/`)
- `npm run synth` still green (no stack changes in this plan)
- Manual smoke list (ts-node, no deploy needed): `/alive`→200 empty, `/now`→ISO, `/api/version`→version, `/api/config`→JSON with featureFlags, `/nope`→404 envelope, `POST /api/ciphers`→404 envelope (not a 500)
</verification>

<success_criteria>
- All 4 boot endpoints respond exactly as vaultwarden-compatible
- No endpoint can produce a raw Lambda error page — everything is the Bitwarden envelope
- Router is ready for Phase 2's auth routes
</success_criteria>

<output>
After completion, create `.planning/phases/01-serverless-skeleton/02-SUMMARY.md`
</output>