import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Backup } from '../lib/constructs/backup';
import { CostGuard } from '../lib/constructs/cost-guard';
import { Storage } from '../lib/constructs/storage';

interface Built {
  readonly stack: cdk.Stack;
  readonly backup: Backup;
  readonly template: Template;
}

function build(alertEmail?: string): Built {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  const storage = new Storage(stack, 'Storage');
  const backup = new Backup(stack, 'Backup', {
    vpc: storage.vpc,
    fileSystem: storage.fileSystem,
    accessPoint: storage.accessPoint,
    bucket: storage.backupBucket,
    alertEmail,
  });
  new CostGuard(stack, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: 'test@example.com' });
  return { stack, backup, template: Template.fromStack(stack) };
}

function synth(): Template {
  return build().template;
}

function backupFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden-backup');
  expect(match).toBeDefined();
  return match;
}

function restoreFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden-restore');
  expect(match).toBeDefined();
  return match;
}

/** Logical ID of a construct's default child, for pinning assertions to a specific resource. */
function logicalIdOf(stack: cdk.Stack, construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as cdk.CfnElement);
}

describe('Backup', () => {
  it('runs nightly at 03:00 UTC', () => {
    synth().hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 3 * * ? *)',
      State: 'ENABLED',
    });
  });

  it('runs on arm64 Python 3.12 and mounts the same EFS path', () => {
    const fn = backupFunction(synth()).Properties;
    expect(fn.Architectures).toEqual(['arm64']);
    expect(fn.Runtime).toBe('python3.12');
    expect(fn.FileSystemConfigs[0].LocalMountPath).toBe('/mnt/data');
    expect(fn.Environment.Variables.DB_PATH).toBe('/mnt/data/db.sqlite3');
  });

  it('sizes /tmp for a snapshot and its gzip to coexist, not the unsized 512 MiB default', () => {
    expect(backupFunction(synth()).Properties.EphemeralStorage).toEqual({ Size: 1024 });
  });

  it('grants the backup role exactly EFS mount/write plus write-only S3 upload actions', () => {
    const { stack, backup, template } = build();
    const roleLogicalId = logicalIdOf(stack, backup.handler.role!);

    // Scoped to the backup handler's own role policy specifically, not "whichever
    // IAM::Policy resources happen to exist in this synth" — a future construct
    // added to this stack that also creates a policy must not silently widen (or
    // narrow) what this assertion is checking.
    const policies = template.findResources('AWS::IAM::Policy');
    const ownPolicy = Object.values(policies).find(
      (p: any) => p.Properties.Roles?.some((r: any) => r.Ref === roleLogicalId),
    ) as any;
    expect(ownPolicy).toBeDefined();

    const actions = ownPolicy.Properties.PolicyDocument.Statement
      .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .sort();

    // Positive allow-list, not a denylist: any action added beyond this exact
    // set — s3:GetObject, s3:DeleteObject, s3:*, dynamodb:*, anything — fails
    // this test, not just the handful of substrings a denylist happens to name.
    // grantPut() on aws-cdk-lib 2.263.0 (no grantWriteWithoutAcl override in
    // this project's context) issues six S3 actions, not the two the original
    // plan assumed; asserted here as what synthesis actually produces.
    expect(actions).toEqual([
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
      's3:Abort*',
      's3:PutObject',
      's3:PutObjectLegalHold',
      's3:PutObjectRetention',
      's3:PutObjectTagging',
      's3:PutObjectVersionTagging',
    ]);

    // Belt-and-braces: even if the exact set above ever drifts, none of these
    // broad wildcards may appear. Each would grant read or delete access wider
    // than "write your own objects, abort your own multipart uploads" — the
    // property that must hold is that a compromised backup role can neither
    // exfiltrate nor destroy historical vault snapshots.
    for (const wildcard of ['s3:*', 's3:Get*', 's3:Delete*', 's3:List*']) {
      expect(actions).not.toContain(wildcard);
    }
  });

  it('caps its own concurrency so a schedule storm cannot run away', () => {
    expect(backupFunction(synth()).Properties.ReservedConcurrentExecutions).toBe(1);
  });

  it('creates no failure alarm or topic when no alert email is configured', () => {
    const { template } = build();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });

  it('alarms on backup errors and emails the configured address when an alert email is set', () => {
    const { stack, backup, template } = build('ops@example.com');
    const handlerLogicalId = logicalIdOf(stack, backup.handler);

    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });

    const topicLogicalIds = Object.keys(template.findResources('AWS::SNS::Topic'));
    expect(topicLogicalIds).toHaveLength(1);

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const errorAlarm = Object.values(alarms).find(
      (a: any) =>
        a.Properties.MetricName === 'Errors' &&
        a.Properties.Namespace === 'AWS/Lambda' &&
        a.Properties.Dimensions?.some(
          (d: any) => d.Name === 'FunctionName' && d.Value?.Ref === handlerLogicalId,
        ),
    ) as any;
    expect(errorAlarm).toBeDefined();
    expect(errorAlarm.Properties.Threshold).toBe(1);
    expect(errorAlarm.Properties.EvaluationPeriods).toBe(1);
    expect(errorAlarm.Properties.TreatMissingData).toBe('notBreaching');
    expect(errorAlarm.Properties.AlarmActions).toEqual([{ Ref: topicLogicalIds[0] }]);
  });
});

describe('Restore', () => {
  it('runs on arm64 Python 3.12, mounts the same EFS path, and is capped at concurrency 1', () => {
    const fn = restoreFunction(synth()).Properties;
    expect(fn.Architectures).toEqual(['arm64']);
    expect(fn.Runtime).toBe('python3.12');
    expect(fn.Handler).toBe('restore.handler');
    expect(fn.FileSystemConfigs[0].LocalMountPath).toBe('/mnt/data');
    expect(fn.Environment.Variables.DB_PATH).toBe('/mnt/data/db.sqlite3');
    expect(fn.ReservedConcurrentExecutions).toBe(1);
  });

  it('sizes /tmp for a snapshot and its gzip to coexist, same as the backup function', () => {
    expect(restoreFunction(synth()).Properties.EphemeralStorage).toEqual({ Size: 1024 });
  });

  it('has no EventBridge rule targeting it — it is invoked manually, not on a schedule', () => {
    const { stack, backup, template } = build();
    const restoreLogicalId = logicalIdOf(stack, backup.restoreHandler);

    // There must still be exactly one schedule in the whole stack (the nightly
    // backup's), and it must not name the restore function among its targets.
    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules)).toHaveLength(1);

    const targetsRestoreFunction = Object.values(rules).some((r: any) =>
      r.Properties.Targets?.some((t: any) => t.Arn?.['Fn::GetAtt']?.[0] === restoreLogicalId),
    );
    expect(targetsRestoreFunction).toBe(false);
  });

  it('may read the backup bucket and check the application function\'s concurrency, while the backup role remains exactly as write-only as before', () => {
    const { stack, backup, template } = build();
    const restoreRoleLogicalId = logicalIdOf(stack, backup.restoreHandler.role!);
    const backupRoleLogicalId = logicalIdOf(stack, backup.handler.role!);

    const policies = template.findResources('AWS::IAM::Policy');

    const restorePolicy = Object.values(policies).find(
      (p: any) => p.Properties.Roles?.some((r: any) => r.Ref === restoreRoleLogicalId),
    ) as any;
    expect(restorePolicy).toBeDefined();

    const restoreActions = restorePolicy.Properties.PolicyDocument.Statement
      .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .sort();

    // Positive allow-list: EFS mount/write (needed to reach the live database),
    // s3 read/list (needed for both the "list" and "restore" actions, granted via
    // bucket.grantRead — grantPut's own comment above notes CDK's grants issue
    // more than the plan's naive two-action guess; asserted here as what
    // synthesis actually produces), and GetFunctionConcurrency scoped to the
    // application function. Nothing else — not s3:Put*, not s3:Delete*, not '*'.
    expect(restoreActions).toEqual([
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
      'lambda:GetFunctionConcurrency',
      's3:GetBucket*',
      's3:GetObject*',
      's3:List*',
    ]);
    for (const wildcard of ['s3:*', 's3:Put*', 's3:Delete*']) {
      expect(restoreActions).not.toContain(wildcard);
    }

    // The GetFunctionConcurrency grant is scoped to the vaultwarden function's
    // own ARN, not '*'.
    const concurrencyStatement = restorePolicy.Properties.PolicyDocument.Statement.find(
      (s: any) => s.Action === 'lambda:GetFunctionConcurrency',
    );
    expect(concurrencyStatement.Resource).not.toBe('*');
    expect(JSON.stringify(concurrencyStatement.Resource)).toContain('vaultwarden');

    // The backup role's own policy is unchanged by this task: it still shows
    // none of the read actions just granted to restore. This is a fresh
    // assertion (not just relying on the write-only test above) so that this
    // specific task cannot be the one that silently widened it.
    const backupPolicy = Object.values(policies).find(
      (p: any) => p.Properties.Roles?.some((r: any) => r.Ref === backupRoleLogicalId),
    ) as any;
    const backupActions = backupPolicy.Properties.PolicyDocument.Statement.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    for (const readAction of [
      's3:GetObject*',
      's3:GetBucket*',
      's3:List*',
      'lambda:GetFunctionConcurrency',
    ]) {
      expect(backupActions).not.toContain(readAction);
    }
  });
});

describe('CostGuard', () => {
  it('alerts once monthly spend is forecast to exceed the limit', () => {
    synth().hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
    });
  });
});
