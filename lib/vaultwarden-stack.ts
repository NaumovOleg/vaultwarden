import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Application } from './constructs/application';
import { Backup } from './constructs/backup';
import { CostGuard } from './constructs/cost-guard';
import { Storage } from './constructs/storage';

export class VaultwardenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage');

    new cdk.CfnOutput(this, 'BackupBucketName', { value: storage.backupBucket.bucketName });

    const alertEmail = this.node.tryGetContext('vaultwarden:alertEmail');

    new Backup(this, 'Backup', {
      vpc: storage.vpc,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      bucket: storage.backupBucket,
      alertEmail,
    });

    if (alertEmail) {
      new CostGuard(this, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: alertEmail });
    }

    const domain = this.node.tryGetContext('vaultwarden:domain') ?? 'https://localhost';
    const imageTag = this.node.tryGetContext('vaultwarden:imageTag') ?? '1.35.1-alpine';
    // The 2FA-lockout escape hatch (README §10). Blank by default in cdk.json;
    // set via --context vaultwarden:adminToken=... for a temporary deployment,
    // then redeploy without it.
    const adminToken = this.node.tryGetContext('vaultwarden:adminToken');

    const application = new Application(this, 'Application', {
      vpc: storage.vpc,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      domain,
      imageTag,
      adminToken,
    });

    new cdk.CfnOutput(this, 'CdnDomainName', {
      value: `https://${application.distribution.distributionDomainName}`,
      description: 'Public URL. Put this in cdk.json as vaultwarden:domain, then redeploy.',
    });
  }
}
