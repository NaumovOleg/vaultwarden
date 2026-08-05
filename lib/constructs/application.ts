import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as efs from "aws-cdk-lib/aws-efs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";

export interface ApplicationProps {
  readonly vpc: ec2.IVpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  /** Absolute public URL. Placeholder on the first deploy — see the README. */
  readonly domain: string;
  /** Container image tag, e.g. "1.35.1-alpine". */
  readonly imageTag: string;
  /**
   * The 2FA-lockout escape hatch. Optional and empty by default (cdk.json ships
   * vaultwarden:adminToken blank), mirroring alertEmail and imageTag: when unset
   * or empty, ADMIN_TOKEN is entirely absent from the environment — exactly as
   * before this prop existed — which is what disables /admin. Set it via
   * `--context vaultwarden:adminToken=...`, deploy, clear the 2FA entry through
   * /admin, then redeploy with it unset again. See README §10 and design spec §5.5.
   */
  readonly adminToken?: string;
  /**
   * Vaultwarden's `SIGNUPS_ALLOWED`. `'false'` by default, and it must be
   * `'false'` in steady state — an open server lets anyone on the internet
   * register an account on it.
   *
   * It exists as a prop because with it hardcoded to `'false'` the owner
   * account could never be created at all. Vaultwarden 1.35.1 admits a
   * registration only when `Invitation::take(&email, ..) ||
   * CONFIG.is_signup_allowed(&email)` (`src/api/core/accounts.rs`); there is no
   * first-user bootstrap exception. With no `ADMIN_TOKEN` (so no `/admin` to
   * send an invitation from) and no SMTP, a stack that ships `'false'` from the
   * first deploy is a vault nobody can ever log into.
   *
   * The bootstrap is folded into the existing two-pass first deployment: pass 1
   * runs with `--context vaultwarden:signupsAllowed=true`, pass 2 returns it to
   * the `'false'` default along with the real DOMAIN. See README §4/§5 and
   * design spec §5.4.
   */
  readonly signupsAllowed?: string;
}

const MOUNT_PATH = "/mnt/data";

export class Application extends Construct {
  readonly handler: lambda.DockerImageFunction;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ApplicationProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/aws/lambda/vaultwarden",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = {
      DATA_FOLDER: MOUNT_PATH,
      DATABASE_URL: `${MOUNT_PATH}/db.sqlite3`,
      // Mandatory. Vaultwarden turns WAL on at startup by default; WAL
      // coordinates readers through an mmap'd shared-memory file, which NFS
      // does not provide, so the process aborts on EFS. Must be present from
      // the first boot — one start without it writes WAL into the file.
      ENABLE_DB_WAL: "false",
      DOMAIN: props.domain,
      // Closed unless the operator deliberately opens it for the pass-1
      // bootstrap deploy. See ApplicationProps.signupsAllowed.
      SIGNUPS_ALLOWED: props.signupsAllowed === "true" ? "true" : "false",
      SIGNUPS_VERIFY: "false",
      INVITATIONS_ALLOWED: "false",
      // The function has no outbound internet, but an external icon
      // service doesn't need it: Vaultwarden answers /icons/<domain>/icon.png
      // with an HTTP redirect and never fetches the image itself — the
      // client (browser extension, app, or web vault) fetches it directly
      // from the provider. See the design spec's accepted-limitations
      // section for the privacy trade-off this implies.
      ICON_SERVICE: "duckduckgo",
      // Function URLs cannot carry WebSocket; clients fall back to polling.
      WEBSOCKET_ENABLED: "false",
      // CloudFront sets X-Forwarded-For, not Vaultwarden's default
      // X-Real-IP. Without this every request looks like one IP and the
      // login rate limit becomes useless.
      IP_HEADER: "X-Forwarded-For",
      LOGIN_RATELIMIT_SECONDS: "60",
      LOGIN_RATELIMIT_MAX_BURST: "5",
      ROCKET_PROFILE: "release",
      // ADMIN_TOKEN is deliberately absent by default: that is what disables
      // /admin. Set only below, and only when props.adminToken is non-empty —
      // see ApplicationProps.adminToken for the escape hatch this exists for.
    };

    if (props.adminToken) {
      environment.ADMIN_TOKEN = props.adminToken;
    }

    this.handler = new lambda.DockerImageFunction(this, "Handler", {
      functionName: "vaultwarden",
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, "..", "..", "docker", "vaultwarden"),
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
      //
      // Reserving anything at all requires the account to keep >= 100
      // UNRESERVED concurrent executions. New AWS accounts are capped at 10
      // until a Service Quotas increase is granted, and until then every
      // reservation is rejected — including a reservation of 0, which is what
      // the restore runbook uses to quiesce this function. Raise the "Concurrent
      // executions" quota before deploying; do not delete this line instead.
      reservedConcurrentExecutions: 10,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(
        props.accessPoint,
        MOUNT_PATH,
      ),
      logGroup,
      environment,
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
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };
    const cached = {
      ...shared,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    };

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "Vaultwarden",
      defaultBehavior: {
        ...shared,
        // Vault API responses must never be cached at the edge.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      // Static web-vault assets only. No credentials, no database access.
      // Caching them keeps repeat loads from reaching the function at all.
      additionalBehaviors: {
        "/app/*": cached,
        "/images/*": cached,
        "/fonts/*": cached,
        "/scripts/*": cached,
        // The redirect ICON_SERVICE produces is identical per domain and
        // carries no credentials. Without caching it, every icon in a vault
        // list re-invokes the function; a list view requests many icons in
        // parallel, and reservedConcurrentExecutions: 10 would turn that
        // into 429s. Caching means only the first request per edge location
        // ever reaches the function.
        "/icons/*": cached,
      },
      // No geo restriction: the owner travels.
      // No WAF: $5/month base is over thirty times the rest of the stack.
    });
  }
}
