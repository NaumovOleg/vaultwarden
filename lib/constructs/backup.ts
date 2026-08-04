import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface BackupProps {
  readonly vpc: ec2.IVpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  readonly bucket: s3.IBucket;
}

const MOUNT_PATH = '/mnt/data';

export class Backup extends Construct {
  readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props: BackupProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/aws/lambda/vaultwarden-backup',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.Function(this, 'Handler', {
      functionName: 'vaultwarden-backup',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambda', 'backup'), {
        exclude: ['test_*.py', 'requirements-dev.txt', '__pycache__', '.pytest_cache'],
      }),
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(props.accessPoint, MOUNT_PATH),
      logGroup,
      environment: {
        DB_PATH: `${MOUNT_PATH}/db.sqlite3`,
        BUCKET_NAME: props.bucket.bucketName,
      },
    });

    props.fileSystem.connections.allowDefaultPortFrom(this.handler);

    // Write-only on purpose. A compromised backup role must not be able to read
    // historical vault snapshots back out, nor delete them. Restores are a
    // deliberate human action taken with the account's own credentials.
    props.bucket.grantPut(this.handler);

    new events.Rule(this, 'Nightly', {
      // boto3 reaches S3 through the free gateway VPC endpoint created in Storage.
      schedule: events.Schedule.expression('cron(0 3 * * ? *)'),
      targets: [new targets.LambdaFunction(this.handler)],
    });
  }
}
