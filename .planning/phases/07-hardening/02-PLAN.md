---
phase: 07-hardening
plan: 02
type: execute
wave: 2
depends_on: [01]
files_modified: [lib/vaultwarden-stack.ts, docs/ops/backup-restore.md, README.md, .planning/STATE.md]
autonomous: true

must_haves:
  truths:
    - "CloudWatch alarm: Lambda Errors >0 over 5 min (1 period) → SNS topic → same email as the budget; plus API GW 5xx alarm (metric from ApiGatewayHttpApi default: 5XXError) — one SNS topic, two alarms"
    - "PITR restore runbook: docs/ops/backup-restore.md — DynamoDB PITR restore-to-new-table + repoint VAULT_TABLE env + attachments S3 versioning restore (prefix restore from versioned objects, delete-markers excluded), validation steps, cd order"
    - "README gets a Monitoring/Backup section pointing at the runbook + alarms"
  artifacts:
    - "alarms wired, runbook doc, README section"
  key_links:
    - "existing CostGuard budget construct — reuse its email; alarms are plain CfnAlarm (no construct exists)"
---

<objective>
Monitoring + backup story: CloudWatch alarms, PITR restore runbook, README section. No SDK E2E harness — bash e2e scripts are the established verification (documented decision).
</objective>

<execution_context>
@.planning/PROJECT.md
</execution_context>

<context>
@lib/constructs/cost-guard.ts
@lib/vaultwarden-stack.ts
@README.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: CloudWatch alarms</name>
  <files>lib/vaultwarden-stack.ts</files>
  <action>
    - SNS topic (email subscription, same notifyEmails context)
    - Alarm 1: Lambda Errors metric (namespace AWS/Lambda, metric Errors, dimensions FunctionName=handler.functionName) — threshold 1 over 1×5min static
    - Alarm 2: API GW 5XXError (HttpApi metric, ApiId) — threshold 1
  </verify>
  `npx tsc --noEmit` + stack.test.ts synth green (test asserts alarm resources exist? add assertion via Match in stack.test.ts)
  <done>Alarms wired.</done>
</task>

<task type="auto">
  <name>Task 2: restore runbook + README</name>
  <files>docs/ops/backup-restore.md, README.md</files>
  <action>
    - runbook: PITR restore (console + CLI), repoint env (cdk deploy with VAULT_TABLE=restored), attachment restore via S3 versioning (list-object-versions → latest non-delete-marker → copy), smoke e2e
    - README: Monitoring & Backup section (alarm email, budget, runbook link, backup scope: table PITR 35d + bucket versioning)
  </verify>
  markdown renders; no code changes
  <done>Runbook + README live.</done>
</task>

</tasks>

<verification>
- `npm test` + tsc green
</verification>

<success_criteria>
- Failed Lambda invocation pages an email within 5 minutes; restore path documented end-to-end
</success_criteria>

<output>
After completion, update .planning/STATE.md, write 02-SUMMARY.md.
</output>