import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Application } from '../lib/constructs/application';
import { Storage } from '../lib/constructs/storage';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  const storage = new Storage(stack, 'Storage');
  new Application(stack, 'App', {
    vpc: storage.vpc,
    fileSystem: storage.fileSystem,
    accessPoint: storage.accessPoint,
    domain: 'https://example.cloudfront.net',
    imageTag: '1.35.1-alpine',
  });
  return Template.fromStack(stack);
}

function appFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden');
  expect(match).toBeDefined();
  return match;
}

// Docker build args are not part of the CloudFormation template's Properties
// — they only appear in a resource's Metadata, and only once the CDK app
// opts in via the 'aws:cdk:enable-asset-metadata' context key (this is what
// `cdk synth` does by default; a bare `new cdk.App()` does not). This helper
// exists only to prove imageTag actually reaches the Docker build; the other
// tests in this file use the plain `synth()` above.
function synthWithImageTag(imageTag: string): Template {
  const app = new cdk.App({ context: { 'aws:cdk:enable-asset-metadata': true } });
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  const storage = new Storage(stack, 'Storage');
  new Application(stack, 'App', {
    vpc: storage.vpc,
    fileSystem: storage.fileSystem,
    accessPoint: storage.accessPoint,
    domain: 'https://example.cloudfront.net',
    imageTag,
  });
  return Template.fromStack(stack);
}

describe('Application function', () => {
  it('runs on arm64 for cheaper GB-seconds', () => {
    expect(appFunction(synth()).Properties.Architectures).toEqual(['arm64']);
  });

  it('caps concurrency at 10 to bound spend without throttling asset bursts', () => {
    expect(appFunction(synth()).Properties.ReservedConcurrentExecutions).toBe(10);
  });

  it('disables SQLite WAL, which cannot work on a network filesystem', () => {
    expect(appFunction(synth()).Properties.Environment.Variables.ENABLE_DB_WAL).toBe('false');
  });

  it('never sets ADMIN_TOKEN, which is what disables the /admin route', () => {
    expect(appFunction(synth()).Properties.Environment.Variables).not.toHaveProperty('ADMIN_TOKEN');
  });

  it('sets ADMIN_TOKEN only when the adminToken prop is supplied — the 2FA-lockout escape hatch', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
    const storage = new Storage(stack, 'Storage');
    new Application(stack, 'App', {
      vpc: storage.vpc,
      fileSystem: storage.fileSystem,
      accessPoint: storage.accessPoint,
      domain: 'https://example.cloudfront.net',
      imageTag: '1.35.1-alpine',
      adminToken: 'temporary-admin-token',
    });
    const t = Template.fromStack(stack);

    expect(appFunction(t).Properties.Environment.Variables.ADMIN_TOKEN).toBe('temporary-admin-token');
  });

  it('reads the client IP from the header CloudFront actually sets', () => {
    expect(appFunction(synth()).Properties.Environment.Variables.IP_HEADER).toBe('X-Forwarded-For');
  });

  it('closes registration and disables features that need outbound internet', () => {
    const env = appFunction(synth()).Properties.Environment.Variables;
    expect(env.SIGNUPS_ALLOWED).toBe('false');
    expect(env.INVITATIONS_ALLOWED).toBe('false');
    expect(env.WEBSOCKET_ENABLED).toBe('false');
    expect(env.DATABASE_URL).toBe('/mnt/data/db.sqlite3');
    expect(env.DATA_FOLDER).toBe('/mnt/data');
  });

  it('uses the duckduckgo icon service, which redirects clients instead of fetching icons itself', () => {
    const env = appFunction(synth()).Properties.Environment.Variables;
    expect(env.ICON_SERVICE).toBe('duckduckgo');
    // Leaving DISABLE_ICON_DOWNLOAD set alongside ICON_SERVICE would be
    // contradictory configuration.
    expect(env).not.toHaveProperty('DISABLE_ICON_DOWNLOAD');
  });

  it('rate limits login attempts', () => {
    const env = appFunction(synth()).Properties.Environment.Variables;
    expect(env.LOGIN_RATELIMIT_SECONDS).toBe('60');
    expect(env.LOGIN_RATELIMIT_MAX_BURST).toBe('5');
  });

  it('mounts EFS at /mnt/data', () => {
    expect(appFunction(synth()).Properties.FileSystemConfigs[0].LocalMountPath).toBe('/mnt/data');
  });

  it('retains logs for one week to stay inside the free tier', () => {
    synth().hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/vaultwarden',
      RetentionInDays: 7,
    });
  });

  it('grants the function role exactly EFS client-mount and client-write, scoped to this access point and filesystem', () => {
    const policies = synth().findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );

    // Positive allow-list, not a denylist: any action added beyond these two
    // EFS actions — s3:GetObject, dynamodb:*, iam:PassRole, anything —
    // fails this test, not just the handful of substrings a denylist
    // happens to name. (CloudWatch Logs access is granted separately via
    // the AWSLambdaBasicExecutionRole managed policy on the role, not via
    // this custom inline policy, so it is out of scope here.)
    expect(statements.map((s: any) => s.Action).sort()).toEqual([
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
    ]);
    expect(statements.every((s: any) => s.Effect === 'Allow')).toBe(true);

    // ClientMount is conditioned on this construct's own access point, not
    // granted against a blanket Resource: '*'.
    const mount = statements.find((s: any) => s.Action === 'elasticfilesystem:ClientMount');
    expect(mount.Resource).toBe('*');
    expect(Object.keys(mount.Condition.StringEquals)).toEqual(['elasticfilesystem:AccessPointArn']);

    // ClientWrite is resourced to this construct's own filesystem ARN, not '*'.
    const write = statements.find((s: any) => s.Action === 'elasticfilesystem:ClientWrite');
    expect(write.Resource).not.toBe('*');
  });

  it('wires imageTag through to the Docker build so an upgrade actually changes the deployed image', () => {
    const t = synthWithImageTag('9.9.9-test-tag');
    expect(appFunction(t).Metadata['aws:asset:docker-build-args']).toEqual({
      VW_TAG: '9.9.9-test-tag',
    });
  });
});

describe('Public entry point', () => {
  it('requires SigV4 on the Function URL so it cannot be invoked directly', () => {
    synth().hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });

  it('signs origin requests with an Origin Access Control', () => {
    const t = synth();
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  it('never caches API responses and forces HTTPS', () => {
    synth().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          // CachingDisabled managed policy
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  it('does not forward the viewer Host header, which would break the signature', () => {
    synth().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          // AllViewerExceptHostHeader managed policy
          OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
        }),
      }),
    });
  });

  it('caches the five static/icon path prefixes so repeat loads bypass Lambda', () => {
    const dists = synth().findResources('AWS::CloudFront::Distribution');
    const behaviors = Object.values(dists)[0].Properties.DistributionConfig.CacheBehaviors;
    expect(behaviors.map((b: any) => b.PathPattern).sort())
      .toEqual(['/app/*', '/fonts/*', '/icons/*', '/images/*', '/scripts/*']);
    for (const b of behaviors) {
      // CachingOptimized managed policy
      expect(b.CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6');
    }
  });
});
