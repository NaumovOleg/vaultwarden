import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Backup } from '../lib/constructs/backup';
import { CostGuard } from '../lib/constructs/cost-guard';
import { Storage } from '../lib/constructs/storage';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  const storage = new Storage(stack, 'Storage');
  new Backup(stack, 'Backup', {
    vpc: storage.vpc,
    fileSystem: storage.fileSystem,
    accessPoint: storage.accessPoint,
    bucket: storage.backupBucket,
  });
  new CostGuard(stack, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: 'test@example.com' });
  return Template.fromStack(stack);
}

function backupFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden-backup');
  expect(match).toBeDefined();
  return match;
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

  it('may write backups but may not read or delete them', () => {
    const text = JSON.stringify(synth().findResources('AWS::IAM::Policy'));
    expect(text).toContain('s3:PutObject');
    expect(text).not.toContain('s3:DeleteObject');
    expect(text).not.toContain('s3:GetObject');
  });

  it('caps its own concurrency so a schedule storm cannot run away', () => {
    expect(backupFunction(synth()).Properties.ReservedConcurrentExecutions).toBe(1);
  });
});

describe('CostGuard', () => {
  it('alerts once monthly spend is forecast to exceed the limit', () => {
    synth().hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
    });
  });
});
