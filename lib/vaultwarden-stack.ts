import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
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

    // Both the backup-failure alarm and the budget are conditional on this
    // address, because an SNS subscription or a CfnBudget subscriber with an
    // empty address fails at deploy time. That conditional is correct; what is
    // not acceptable is it being silent. cdk.json ships the key blank, so the
    // default synthesis has no alarm and no budget at all — and the backup
    // bucket expires objects after 90 days, so a nightly backup that starts
    // failing is invisible until the last good snapshot has already expired.
    if (!alertEmail) {
      cdk.Annotations.of(this).addWarning(
        'vaultwarden:alertEmail is not set: this stack synthesises with NO backup-failure ' +
        'alarm, NO SNS topic and NO AWS Budgets cost alert. A failing nightly backup will be ' +
        'silent, and the S3 lifecycle rule expires the last good snapshot after 90 days. Set ' +
        'it in cdk.json or pass --context vaultwarden:alertEmail=you@example.com.',
      );
    }

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
    // ACM certificate for the custom domain, referenced from us-east-1 (the
    // region CloudFront requires for alternate names). Imported by ARN rather
    // than issued here: issuance is a manual DNS-validation step in another
    // region. See cdk.json.
    const certificateArn = this.node.tryGetContext('vaultwarden:certificateArn');
    const certificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'DomainCertificate', certificateArn)
      : undefined;
    const domainNames = certificate ? [new URL(domain).hostname] : undefined;
    const imageTag = this.node.tryGetContext('vaultwarden:imageTag') ?? '1.35.1-alpine';
    // The 2FA-lockout escape hatch (README §10). Blank by default in cdk.json;
    // set via --context vaultwarden:adminToken=... for a temporary deployment,
    // then redeploy without it.
    const adminToken = this.node.tryGetContext('vaultwarden:adminToken');
    // Normalised to a string here rather than in the construct so that a JSON
    // `true` in cdk.json and a CLI `--context vaultwarden:signupsAllowed=true`
    // (always a string) mean the same thing. Anything that is not exactly
    // "true" leaves registration closed — the fail-closed direction.
    const signupsAllowed = String(
      this.node.tryGetContext('vaultwarden:signupsAllowed') ?? 'false',
    );

    const application = new Application(this, 'Application', {
      vpc: storage.vpc,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      domain,
      certificate,
      domainNames,
      imageTag,
      adminToken,
      signupsAllowed,
    });

    new cdk.CfnOutput(this, 'CdnDomainName', {
      value: `https://${application.distribution.distributionDomainName}`,
      description: 'Public URL. Put this in cdk.json as vaultwarden:domain, then redeploy.',
    });
  }
}
