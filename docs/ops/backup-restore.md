# Backup & Restore Runbook

Scope: the Vaultwarden-serverless stack's data is DynamoDB (`VaultTable`, PITR
35 days) + S3 `attachments` (versioned) + S3 `icons` (cache, disposable).
The web vault static files and CDK config are in git/CDK — rebuildable, not data.

## What is backed up

| Asset | Mechanism | Retention |
| --- | --- | --- |
| Vault table (users, ciphers, orgs, sessions) | DynamoDB PITR | 35 days |
| Attachments + send files | S3 versioning | every version, forever until lifecycle added |
| Icons cache | none (re-fetchable) | disposable |

## Restore: DynamoDB table

The table is `RETAIN`, so a stack destroy does not delete it — recoveries are
point-in-time restores to a NEW table, then repoint the Lambda.

1. Pick the restore timestamp (UTC, max 35 days back, every 5 min granularity):
   ```bash
   aws dynamodb list-continuous-backups --table-name VaultTable
   aws dynamodb describe-continuous-backups --table-name VaultTable
   ```
2. Restore to a new table:
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name VaultTable \
     --target-table-name VaultTable-restored \
     --restore-date-time 2026-08-17T12:00:00Z
   ```
   Wait for `ACTIVE`:
   ```bash
   aws dynamodb wait table-exists --table-name VaultTable-restored
   ```
3. Repoint the Lambda and redeploy. The env var is controlled by the stack:
   currently `VAULT_TABLE` is hard-wired to the stack's table — set it via
   context or patch `lib/vaultwarden-stack.ts` (`VAULT_TABLE: 'VaultTable-restored'`),
   then `npx cdk deploy`.
   Restored tables have the same key schema (pk/sk + GSI1) but NO TTL config —
   check `expiresAt` TTL on the restored table and re-add it (sessions/rate
   limit rows depend on TTL cleanup).
4. Verify: `curl <domain>/alive` 200; login with an existing account; `GET /api/sync`
   shows expected folders/ciphers; open the web vault.
5. Cutover: when satisfied, delete or rename the old table (it is RETAIN; keep
   it as a manual backup until you're confident).

## Restore: attachments (S3 versioning)

Objects are versioned; a delete creates a delete-marker. To recover a cipher's
attachments or an accidentally deleted object:

1. List versions under the prefix:
   ```bash
   aws s3api list-object-versions --bucket <attachments-bucket> \
     --prefix attachments/ --query 'Versions[?IsLatest==`true`]'
   ```
2. Find the latest non-delete-marker version id and restore it:
   ```bash
   aws s3api list-object-versions --bucket <attachments-bucket> \
     --prefix attachments/<cipherId>/ --query \
     'Versions[?IsLatest==`true`] || Versions[0]'
   aws s3api copy-object --bucket <attachments-bucket> \
     --copy-source <attachments-bucket>/attachments/<cipherId>/<file> \
     --key attachments/<cipherId>/<file>   # copy of a version removes versioning quirk
   ```
   Simpler bulk path: `aws s3 sync s3://bucket s3://bucket --source-region <r>`
   does not dig into versions — use `list-object-versions` piped to `copy-object`
   per object when a full prefix restore is needed (script one-liner below).

3. Attachment rows in DynamoDB reference file names per cipher — if the table
   was restored too far back, delete/upload attachments fresh from the client.

## Restore: icons

Nothing to do — the cache re-fetches favicons on demand.

## Smoke checklist after any restore

- [ ] `/alive` → 200
- [ ] Login works with a pre-restore account (password + 2FA if set)
- [ ] `GET /api/sync` returns folders + ciphers
- [ ] One attachment downloads byte-identical
- [ ] A send's file downloads
- [ ] TTL re-enabled on restored table if DynamoDB restore was used