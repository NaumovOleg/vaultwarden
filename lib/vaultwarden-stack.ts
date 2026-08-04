import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Application } from './constructs/application';
import { Storage } from './constructs/storage';

export class VaultwardenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage');

    new cdk.CfnOutput(this, 'BackupBucketName', { value: storage.backupBucket.bucketName });

    const domain = this.node.tryGetContext('vaultwarden:domain') ?? 'https://localhost';
    const imageTag = this.node.tryGetContext('vaultwarden:imageTag') ?? '1.35.1-alpine';

    const application = new Application(this, 'Application', {
      vpc: storage.vpc,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      domain,
      imageTag,
    });

    new cdk.CfnOutput(this, 'CdnDomainName', {
      value: `https://${application.distribution.distributionDomainName}`,
      description: 'Public URL. Put this in cdk.json as vaultwarden:domain, then redeploy.',
    });
  }
}
