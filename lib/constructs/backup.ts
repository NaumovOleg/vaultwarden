import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as efs from "aws-cdk-lib/aws-efs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import * as path from "node:path";

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

const MOUNT_PATH = "/mnt/data";

// Fixed rather than threaded in as a prop: this is the same literal
// `functionName: 'vaultwarden'` that lib/constructs/application.ts sets, and
// referencing it by name (via Stack.formatArn below) instead of taking a
// direct reference to the Application construct avoids a hard dependency
// between the two constructs — Backup already doesn't otherwise know
// Application exists, and this task doesn't need to change that.
const APP_FUNCTION_NAME = "vaultwarden";

export class Backup extends Construct {
  readonly handler: lambda.Function;
  readonly restoreHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: BackupProps) {
    super(scope, id);

    // Shared by both functions below: restore.py must live in the same asset
    // directory as index.py and import validate_snapshot from it rather than
    // duplicating it, so both Lambdas are built from one Code.fromAsset call
    // with one exclude list. restore.py is not excluded by either glob.
    const code = lambda.Code.fromAsset(
      path.join(__dirname, "..", "..", "lambda", "backup"),
      {
        exclude: [
          "test_*.py",
          "requirements-dev.txt",
          "__pycache__",
          ".pytest_cache",
        ],
      },
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/aws/lambda/vaultwarden-backup",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.Function(this, "Handler", {
      functionName: "vaultwarden-backup",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      // The snapshot and its gzip both live in /tmp at once (peak usage is
      // roughly 2x the database size), and the default 512 MiB ephemeral
      // storage is an accident of the Lambda default, not a sized decision.
      // 1024 MiB keeps headroom as the vault grows well beyond today's
      // single-user size before this needs revisiting.
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      // One writer at a time against the SQLite file on EFS. The schedule fires
      // once a day, so this costs nothing and bounds a runaway schedule.
      reservedConcurrentExecutions: 1,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props.accessPoint,
        MOUNT_PATH,
      ),
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

    new events.Rule(this, "Nightly", {
      // boto3 reaches S3 through the free gateway VPC endpoint created in Storage.
      schedule: events.Schedule.expression("cron(0 3 * * ? *)"),
      targets: [new targets.LambdaFunction(this.handler)],
    });

    const restoreLogGroup = new logs.LogGroup(this, "RestoreLogs", {
      logGroupName: "/aws/lambda/vaultwarden-restore",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // A restore Lambda, not temporary EC2 infrastructure: the isolated VPC has
    // no SSM/SSH path to a hand-launched instance and no security group rule
    // admitting one to EFS, so a shell on the network was never a workable
    // restore path. This function gets the same EFS access the other two
    // already have, costs $0 when never invoked, and turns the previously
    // undocumented-and-unexecutable restore procedure into a real one. See
    // §7 of the README and §8 of the design spec.
    this.restoreHandler = new lambda.Function(this, "RestoreHandler", {
      functionName: "vaultwarden-restore",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "restore.handler",
      code,
      memorySize: 512,
      // Generous, unlike the nightly job's 5 minutes: this runs rarely, by a
      // human, at an already-stressful moment. There is no cost or scheduling
      // pressure to keep it tight.
      timeout: cdk.Duration.minutes(10),
      // Same reasoning as the backup function above: the downloaded gzip and
      // its decompressed expansion both live in /tmp at once.
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      // Two concurrent restores would race to overwrite the same database file.
      reservedConcurrentExecutions: 1,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props.accessPoint,
        MOUNT_PATH,
      ),
      logGroup: restoreLogGroup,
      environment: {
        DB_PATH: `${MOUNT_PATH}/db.sqlite3`,
        BUCKET_NAME: props.bucket.bucketName,
        APP_FUNCTION_NAME,
      },
      // No EventBridge schedule: invoked manually, deliberately, by a human
      // who has already set the application function's concurrency to 0. An
      // automatically-triggered vault overwrite is not a feature.
    });

    props.fileSystem.connections.allowDefaultPortFrom(this.restoreHandler);

    // Read access to backups, granted to THIS function's role only. The
    // backup role above stays exactly as write-only as it was before this
    // task: restore is a separate function with a separate role, so a
    // compromised backup role still cannot read or delete historical
    // snapshots. Only a compromised restore role could — and that role is
    // never invoked automatically, unlike the nightly backup role.
    props.bucket.grantRead(this.restoreHandler);

    // Scoped to the application function's own ARN, not '*': the restore
    // handler needs to confirm Vaultwarden's reserved concurrency is 0
    // before it is safe to overwrite the database, and nothing more.
    this.restoreHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:GetFunctionConcurrency"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "lambda",
            resource: "function",
            resourceName: APP_FUNCTION_NAME,
          }),
        ],
      }),
    );

    // EventBridge invokes the handler asynchronously: on failure Lambda
    // retries twice, then drops the event. Without this, a broken backup
    // job goes unnoticed until someone actually needs a restore. Lives here
    // rather than in CostGuard because backup health is not spend — folding
    // it into the budget construct would make a cost-forecasting construct
    // also need to know about a specific function's error metric.
    if (props.alertEmail) {
      const topic = new sns.Topic(this, "AlarmTopic", {
        topicName: "vaultwarden-backup-alarms",
      });
      topic.addSubscription(
        new subscriptions.EmailSubscription(props.alertEmail),
      );

      new cloudwatch.Alarm(this, "ErrorsAlarm", {
        metric: this.handler.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(topic));
    }
  }
}
