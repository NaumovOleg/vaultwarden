import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface BackupProps {
  readonly vpc: ec2.IVpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  readonly bucket: s3.IBucket;
  /**
   * Email to notify when the nightly backup fails. Optional, mirroring
   * CostGuard: when omitted (cdk.json ships vaultwarden:alertEmail blank),
   * no SNS topic or alarm is created — an SNS subscription with an empty
   * address would fail at deploy time just like CfnBudget's subscriber does.
   */
  readonly alertEmail?: string;
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
      // The snapshot and its gzip both live in /tmp at once (peak usage is
      // roughly 2x the database size), and the default 512 MiB ephemeral
      // storage is an accident of the Lambda default, not a sized decision.
      // 1024 MiB keeps headroom as the vault grows well beyond today's
      // single-user size before this needs revisiting.
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
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

    // EventBridge invokes the handler asynchronously: on failure Lambda
    // retries twice, then drops the event. Without this, a broken backup
    // job goes unnoticed until someone actually needs a restore. Lives here
    // rather than in CostGuard because backup health is not spend — folding
    // it into the budget construct would make a cost-forecasting construct
    // also need to know about a specific function's error metric.
    if (props.alertEmail) {
      const topic = new sns.Topic(this, 'AlarmTopic', {
        topicName: 'vaultwarden-backup-alarms',
      });
      topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

      new cloudwatch.Alarm(this, 'ErrorsAlarm', {
        metric: this.handler.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(topic));
    }
  }
}
