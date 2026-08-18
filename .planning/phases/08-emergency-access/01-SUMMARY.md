# Phase 8 — Emergency Access: SUMMARY

Plan 01, one wave. 149 tests green, tsc clean.

## What shipped

Emergency access v1 (MISC-05) end-to-end — trust lifecycle + access flow + takeover:

- **Store**: `EmergencyAccessItem` (`EMERG#{grantorId}#{itemId}`, status 0 invited → 1 accepted → 2 confirmed → 3 initiated → 4 approved). Live invites are GSI1-keyed `EMERGTOKEN#{token}`; accept re-keys the row to `EMERGGRANTEE#{granteeId}` (token lookup dies on accept). Dynamo + Memory parity, deleteUser cascades trust rows on both sides.
- **Endpoints** (`src/endpoints/emergency-access.ts`, 18 routes): invite (surfaced token, no-email), reinvite (regenerates token), accept (authed, token-bound), confirm (grantor seals vault key → `encryptedKey`), update type/waitTimeDays, delete (+`/delete`), trusted/granted lists, detail, initiate (wait-time enforced from confirm), approve/reject, view (grantor vault bundle + `encryptedKey`), takeover (full `issueSession` as the grantor via `authenticatedResponse`), password (reset grantor password + akey + stamp rotation, status back to confirmed), policies (empty `listResponse` envelope).
- **Register binding**: `emergencyAccessId` + `emergencyAccessToken` validated pre-register (email must match), binds straight to status 1 with the new account's keys.
- **`static/ea-accept.html`**: mirrors accept.html — register with id+token query params.
- **Tests** (`test/emergency-access.test.ts`, 5 cases): full lifecycle, authed accept, wait-time guard, reinvite/update/delete + wrong-party 404s, policies envelope.
- **e2e-vault.sh step 16**: invite → token register → granted list → confirm → initiate → approve → view → takeover.

## Key decisions

1. Token surfaced in the invite response (no-email mechanism, mirrors org invites) — this is the documented v1 deviation; email delivery is out of scope.
2. Takeover returns a real session (`authenticatedResponse` as the grantor), per plan truth — the grantee is immediately signed in as the grantor; `/password` then resets and stamp-rotates (kills that session too, forcing a clean login with the new password).
3. Wait time counts from confirmation (`revisionDate` bumped at confirm), matching vaultwarden semantics.
4. Single GSI1PK value per row is enough: token lookup only exists while status 0, grantee listing only after accept.

## Known ceilings (ponytail-flagged)

- `GET /{id}/policies` always returns empty `Data` — grantor org policy shape from the orgs phase lands later (plan truth, lazy by design).
- Accept requires the account email to match the invited address; no weak-token backoff (same posture as org invites).
- Avatar stubs + account-misc skipped as planned (web vault renders initials; `premium` already true).

## Owner handoff (run after deploy)

1. `bash scripts/e2e-vault.sh https://<domain>` — all 16 steps green.
2. Web vault → Settings → Emergency Access → invite with surfaced token → open `/ea-accept.html?id=…&token=…` → register → grantor confirms → grantee initiates after wait time → grantor approves → grantee views/takes over.