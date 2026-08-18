# Plan 02 Summary — Boot endpoints

Executed: 2026-08-18. All `must_haves` met.

## What was done

- **src/errors.ts**: `BitwardenError` (status/message/modelState/validationErrors), `toErrorBody()` (exact `{Message, ModelState, ValidationErrors}` envelope, keys never omitted), `notFound()`, `internalError()`.
- **src/endpoints/misc.ts**: `alive` (200 empty), `now` (ISO-8601 UTC), `version` (plain `VERSION` env), `config` (Bitwarden shape).
- **src/handler.ts**: router-wired via `createHandler(routes)` (exported for test injection); unknown → 404 envelope; `BitwardenError` → its status; anything else → logged + 500 envelope; requestId/method/path/status logged every call; JSON responses get `Content-Type: application/json; charset=utf-8`. `// ponytail:` note left for Phase-2 body parsing.
- **src/router.ts**: params URL-decoded, methods raw strings (already the case from Plan 01); `Route` exported.
- Tests: `endpoints.test.ts`, `handler.test.ts` (incl. throwing-route → 500 and BitwardenError → status via `createHandler`), `router.test.ts` unchanged.

## Deviations from plan

- `/api/config` source moved: no `src/api/config.rs` on main — the route lives in `src/api/core/mod.rs` (fetched and mirrored). Current source emits top-level `version`/`featureStates`/`settings`/`environment`/`push`/`communication`; it no longer emits `environment.featureFlags` or `versioning`. We mirror the current source AND keep `environment.featureFlags: {}` + `environment.versioning.serverVersion` (the plan's required keys) — extra fields are ignored by clients.
- `version: "2026.6.0"` is the client-compat version in source; we emit `VERSION` env instead (default `1.0.0-dev`) so the artifact stays truthful.
- `DEFAULT_DOMAIN` env is scheme-less (Plan 01 decision); config() re-adds `https://` when missing so clients get absolute URLs.

## Verification

- `npm test`: 31/31 green (4 suites)
- `tsc --noEmit` green (src added to tsconfig include)
- `npm run synth` still green
- ts-node smoke: alive→200 empty, now→ISO, version→9.9.9, config→200 with featureFlags, /nope→404 envelope, POST /api/ciphers→404 envelope (never 500)