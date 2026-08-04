import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface ApplicationProps {
  readonly vpc: ec2.IVpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  /** Absolute public URL. Placeholder on the first deploy — see the README. */
  readonly domain: string;
  /** Container image tag, e.g. "1.35.1-alpine". */
  readonly imageTag: string;
}

const MOUNT_PATH = '/mnt/data';

export class Application extends Construct {
  readonly handler: lambda.DockerImageFunction;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ApplicationProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/aws/lambda/vaultwarden',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.DockerImageFunction(this, 'Handler', {
      functionName: 'vaultwarden',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '..', '..', 'docker', 'vaultwarden'),
        {
          platform: ecrAssets.Platform.LINUX_ARM64,
          // Threads props.imageTag into the Dockerfile's VW_TAG build arg, so
          // an upgrade is actually a context-value change and redeploy, not
          // just a prop nobody reads.
          buildArgs: { VW_TAG: props.imageTag },
        },
      ),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      // Not 1. Synchronous invocations above a reserved limit are rejected with
      // a 429 rather than queued, and a browser loading the web vault requests
      // a dozen assets in parallel. Those requests never touch the database,
      // and a single user does not generate concurrent writes.
      reservedConcurrentExecutions: 10,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(props.accessPoint, MOUNT_PATH),
      logGroup,
      environment: {
        DATA_FOLDER: MOUNT_PATH,
        DATABASE_URL: `${MOUNT_PATH}/db.sqlite3`,
        // Mandatory. Vaultwarden turns WAL on at startup by default; WAL
        // coordinates readers through an mmap'd shared-memory file, which NFS
        // does not provide, so the process aborts on EFS. Must be present from
        // the first boot — one start without it writes WAL into the file.
        ENABLE_DB_WAL: 'false',
        DOMAIN: props.domain,
        SIGNUPS_ALLOWED: 'false',
        SIGNUPS_VERIFY: 'false',
        INVITATIONS_ALLOWED: 'false',
        // No outbound internet from an isolated subnet.
        DISABLE_ICON_DOWNLOAD: 'true',
        // Function URLs cannot carry WebSocket; clients fall back to polling.
        WEBSOCKET_ENABLED: 'false',
        // CloudFront sets X-Forwarded-For, not Vaultwarden's default
        // X-Real-IP. Without this every request looks like one IP and the
        // login rate limit becomes useless.
        IP_HEADER: 'X-Forwarded-For',
        LOGIN_RATELIMIT_SECONDS: '60',
        LOGIN_RATELIMIT_MAX_BURST: '5',
        ROCKET_PROFILE: 'release',
        // ADMIN_TOKEN is deliberately absent: that is what disables /admin.
      },
    });

    props.fileSystem.connections.allowDefaultPortFrom(this.handler);

    // AWS_IAM, not NONE: an unsigned request to the Function URL gets a 403,
    // so only CloudFront's SigV4-signed requests reach the function.
    const fnUrl = this.handler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);
    const shared = {
      origin,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };
    const cached = { ...shared, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED };

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Vaultwarden',
      defaultBehavior: {
        ...shared,
        // Vault API responses must never be cached at the edge.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      // Static web-vault assets only. No credentials, no database access.
      // Caching them keeps repeat loads from reaching the function at all.
      additionalBehaviors: {
        '/app/*': cached,
        '/images/*': cached,
        '/fonts/*': cached,
        '/scripts/*': cached,
      },
      // No geo restriction: the owner travels.
      // No WAF: $5/month base is over thirty times the rest of the stack.
    });
  }
}
