import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CostGuard } from './constructs/cost-guard';

export class VaultwardenStack extends cdk.Stack {
  public readonly table!: dynamodb.Table;
  public readonly attachmentsBucket!: s3.Bucket;
  public readonly staticBucket!: s3.Bucket;
  public readonly iconsBucket!: s3.Bucket;
  public readonly handler!: lambda.NodejsFunction;
  public readonly api!: cdk.aws_apigatewayv2.HttpApi;
  public readonly distribution!: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const alertEmail = this.node.tryGetContext('vaultwarden:alertEmail');

    // The budget is conditional on an email address because a CfnBudget
    // subscriber with an empty address fails at deploy time.
    if (alertEmail) {
      new CostGuard(this, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: alertEmail });
    } else {
      cdk.Annotations.of(this).addWarning(
        'vaultwarden:alertEmail is not set: this stack synthesises with NO AWS Budgets ' +
        'cost alert. Set it in cdk.json or pass --context vaultwarden:alertEmail=you@example.com.',
      );
    }

    // Single-table design (see .planning/research/ARCHITECTURE.md). RETAIN:
    // this table holds the user's vault, and must survive a stack destroy.
    this.table = new dynamodb.Table(this, 'VaultTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // GSI1: email → PROFILE lookup for prelogin/login (ARCHITECTURE §3.1)
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // Regenerable caches, not data — safe to destroy with the stack.
    const domain = this.node.tryGetContext('vaultwarden:domain') ?? 'https://localhost';
    const vaultOrigin = new URL(domain).hostname;
    this.attachmentsBucket = new s3.Bucket(this, 'AttachmentsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          // Presigned GETs are fetched cross-origin by browser clients (ARCHITECTURE §4.4).
          allowedOrigins: [vaultOrigin],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
        },
      ],
    });
    this.staticBucket = new s3.Bucket(this, 'StaticWebvaultBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    this.iconsBucket = new s3.Bucket(this, 'IconsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const version = this.node.tryGetContext('vaultwarden:version') ?? '1.0.0-dev';
    const signupsAllowed = String(
      this.node.tryGetContext('vaultwarden:signupsAllowed') ?? 'false',
    );

    this.handler = new lambda.NodejsFunction(this, 'Handler', {
      entry: 'src/handler.ts',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        VERSION: version,
        SIGNUPS_ALLOWED: signupsAllowed,
        DEFAULT_DOMAIN: vaultOrigin,
        VAULT_TABLE: this.table.tableName,
        ATTACHMENTS_BUCKET: this.attachmentsBucket.bucketName,
        ICONS_BUCKET: this.iconsBucket.bucketName,
      },
    });
    this.table.grantReadWriteData(this.handler);
    this.attachmentsBucket.grantReadWrite(this.handler);
    this.iconsBucket.grantReadWrite(this.handler);

    // Error alarms → SNS → email. Same conditional as the budget: no email
    // configured means no subscription (a CfnSubscription with an empty
    // address fails at deploy time).

    this.api = new cdk.aws_apigatewayv2.HttpApi(this, 'Api', {
      // Catch-all: every request reaches the Lambda, the router decides.
      defaultIntegration: new cdk.aws_apigatewayv2_integrations.HttpLambdaIntegration(
        'DefaultIntegration',
        this.handler,
      ),
    });

    if (alertEmail) {
      const alarmTopic = new cdk.aws_sns.Topic(this, 'AlarmTopic');
      alarmTopic.addSubscription(new cdk.aws_sns_subscriptions.EmailSubscription(alertEmail));

      new cdk.aws_cloudwatch.Alarm(this, 'LambdaErrorsAlarm', {
        metric: this.handler.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: 'Vaultwarden Lambda threw an unhandled error',
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));

      new cdk.aws_cloudwatch.Alarm(this, 'Api5xxAlarm', {
        metric: new cdk.aws_cloudwatch.Metric({
          namespace: 'AWS/ApiGateway',
          metricName: '5XXError',
          dimensionsMap: { ApiId: this.api.apiId },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: 'API Gateway returned a 5xx response',
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic));
    }

    const certificateArn = this.node.tryGetContext('vaultwarden:certificateArn');
    const certificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'DomainCertificate', certificateArn)
      : undefined;
    const domainNames = certificate ? [new URL(domain).hostname] : undefined;

    const apiOrigin = this.apiBehavior(this.api);
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      certificate,
      domainNames,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.staticBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': apiOrigin,
        '/identity/*': apiOrigin,
        '/icons/*': apiOrigin,
        '/alive': apiOrigin,
        '/now': apiOrigin,
      },
    });

    new cdk.aws_s3_deployment.BucketDeployment(this, 'WebvaultDeployment', {
      sources: [
        cdk.aws_s3_deployment.Source.asset('static/webvault'),
        cdk.aws_s3_deployment.Source.asset('static', { exclude: ['webvault/**'] }),
      ],
      destinationBucket: this.staticBucket,
      prune: true,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'CdnDomainName', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Public URL. Put this in cdk.json as vaultwarden:domain, then redeploy.',
    });
  }

  private apiBehavior(api: cdk.aws_apigatewayv2.HttpApi): cloudfront.BehaviorOptions {
    return {
      // api.apiEndpoint is a lazy token here, so stripping its scheme is a no-op
      // at synth time; build the hostname from the apiId attribute instead.
      origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };
  }
}
