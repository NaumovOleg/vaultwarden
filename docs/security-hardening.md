# Security hardening

Status of the audit findings against this codebase, and the mitigations.
Regression tests live in `test/security.test.ts` (finding #N per describe).

## Fixed (code + tests)

| # | Finding | Fix |
| --- | --- | --- |
| 1 | JWT secret fallback in source | `src/crypto.ts` has no fallback — `signJwt` refuses to run without a secret. Prod Lambda reads an SSM Parameter Store `SecureString` (`JWT_SECRET_REF`, self-provisioned on first cold start; rotation = overwrite the parameter). Local dev uses `JWT_SECRET` (`src/dev.ts` generates one per boot). |
| 2 | Missing input validation / payload limits | Hard request-body limits in `src/handler.ts`: 1MB API, 10MB file-upload routes → 413. RFC 5322-ish `EMAIL_RE` on register/verify/2FA email endpoints. DynamoDB access is parameterized end-to-end (`ExpressionAttributeValues` everywhere — no query-string interpolation exists). |
| 3 | Missing security headers | `SECURITY_HEADERS` merged into every response at the handler choke point (HSTS preload, nosniff, frame-ancestors DENY, no-referrer, CSP); static web vault gets the same set from a CloudFront response-headers policy. Note: the web vault CSP allows same-origin (a `default-src 'none'` would break the SPA). |
| 4 | 2FA codes in logs | Removed. Codes exist only in SES emails or the documented no-mailer dev fallback response body (`dev_code`). A regression test spies on the logger. |
| 5 | IP-based rate limiting | Already present for logins (per-IP + per-email buckets, `src/endpoints/identity.ts`). Added per-IP ceilings for open endpoints: 5 registrations/hr, 10 verify-emails/hr (`consumeRate`, counts successful calls too). |

## Already mitigated by design (no code change)

| # | Finding | Why |
| --- | --- | --- |
| 6 | HTTPS / WAF | CloudFront `REDIRECT_TO_HTTPS` on every behavior (API + static). Direct API Gateway calls are possible but the API serves no HTML/CORS; WAF was skipped (≈$5–6/mo on a ~$1/mo budget deployment) — add `aws_wafv2` association if the API is ever exposed directly. |
| 7 | Audit logging | New: `store.putAudit` (DynamoDB `AUDIT#` items, TTL 30d, secrets-free) at login success/failure, password/KDF change, 2FA enable/disable, recovery-email sent, logout, logout-all, account deletion. Query via `pk` = `AUDIT#<userId>#<ts>#<rand>`. |
| 8 | Token revocation | Sessions are server-side rows, deleted on `endsession`, rotated on refresh, and stamp-rotated on password/KDF change (logout-all = `POST /api/accounts/security-stamp`). A revoked token has no row → 401 immediately; no blacklist needed. |
| 9 | SSRF via /icons | The endpoint only ever fetches a fixed whitelist of upstream hosts (`icons.duckduckgo.com`), never a caller-controlled URL; 10s timeout and 256KB cap. No SSRF surface. |
| 10 | API versioning | Intentionally not done: Bitwarden clients hardcode `/api/...` paths; versioned routes would break every client. Bitwarden server itself does not version the API. |
| 11 | Request timeouts | Lambda timeout is 30s (`lib/vaultwarden-stack.ts`); AWS SDK timeouts/retries cover DynamoDB/S3. |

## Operational notes

- Rotating the JWT key: `aws ssm put-parameter --name <stack>-jwt-secret --value <new> --type SecureString --overwrite` (the running instance re-reads on cold start).
- Audit rows expire via DynamoDB TTL (`expiresAt`, 30 days) — offload with an export if retention beyond that is required.
- No secret ever appears in git history: keys live in SSM/CloudWatch-less code paths only.