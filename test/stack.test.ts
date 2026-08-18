import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VaultwardenStack } from '../lib/vaultwarden-stack';

function synth(context: Record<string, unknown> = {}): Template {
  const app = new cdk.App({ context: { 'vaultwarden:alertEmail': 'test@example.com', ...context } });
  const stack = new VaultwardenStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'eu-west-1' },
  });
  return Template.fromStack(stack);
}

// The nodejs22 API lambda (the stack also creates custom-resource lambdas for
// S3 auto-delete; filter those out by runtime).
function handlerFunction(t: Template): any {
  const fns = Object.values(t.findResources('AWS::Lambda::Function')) as any[];
  const match = fns.find((f) => f.Properties.Runtime === 'nodejs22.x');
  expect(match).toBeDefined();
  return match;
}

describe('VaultwardenStack', () => {
  it('synthesises without error', () => {
    expect(() => synth()).not.toThrow();
  });

  it('creates a DynamoDB table with on-demand billing, PITR and the GSI1 email index', () => {
    const t = synth();
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ]),
      KeySchema: Match.arrayWith([
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ]),
    });
  });

  it('creates the three S3 buckets', () => {
    synth().resourceCountIs('AWS::S3::Bucket', 3);
  });

  it('creates the nodejs22 Lambda with the expected environment', () => {
    const t = synth({
      'vaultwarden:version': '2.0.0',
      'vaultwarden:signupsAllowed': 'true',
      'vaultwarden:domain': 'https://vault.example.com',
    });
    const fn = handlerFunction(t);
    expect(fn.Properties.MemorySize).toBe(512);
    expect(fn.Properties.Timeout).toBe(30);
    expect(fn.Properties.Environment.Variables).toEqual(
      expect.objectContaining({
        VERSION: '2.0.0',
        SIGNUPS_ALLOWED: 'true',
        DEFAULT_DOMAIN: 'vault.example.com',
      }),
    );
    expect(fn.Properties.Environment.Variables.VAULT_TABLE).toBeDefined();
  });

  it('grants the lambda read/write access to the table', () => {
    const t = synth();
    const fn = handlerFunction(t);
    expect(fn.Properties.Role).toBeDefined();
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];
    const statements = policies
      .map((p) => JSON.stringify(p.Properties.PolicyDocument.Statement))
      .join('\n');
    expect(statements).toContain('dynamodb:DescribeTable');
    expect(statements).toContain('dynamodb:PutItem');
    expect(statements).toContain('dynamodb:Query');
  });

  it('creates an HTTP API with a catch-all route to the lambda', () => {
    const t = synth();
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
  });

  it('serves the web vault from S3 via OAC', () => {
    const t = synth();
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const origins = dist.Properties.DistributionConfig.Origins as any[];
    expect(origins.length).toBe(2);
    const s3Origin = origins.find((o) => o.S3OriginConfig !== undefined);
    expect(s3Origin).toBeDefined();
    expect(s3Origin!.OriginAccessControlId).toBeDefined();
  });

  it('routes the five API path behaviors to the gateway, uncached', () => {
    const t = synth();
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const behaviors = dist.Properties.DistributionConfig.CacheBehaviors as any[];
    const paths = behaviors.map((b: any) => b.PathPattern).sort();
    expect(paths).toEqual(['/alive', '/api/*', '/icons/*', '/identity/*', '/now']);
    // Managed-CachingDisabled policy id (CDK CachePolicy.CACHING_DISABLED)
    for (const b of behaviors) {
      expect(b.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    }
    const apiOrigin = dist.Properties.DistributionConfig.Origins.find(
      (o: any) => o.CustomOriginConfig !== undefined,
    );
    expect(apiOrigin).toBeDefined();
    expect(apiOrigin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
  });

  it('uses the custom domain when certificateArn is provided', () => {
    const t = synth({
      'vaultwarden:domain': 'https://vault.example.com',
      'vaultwarden:certificateArn': 'arn:aws:acm:us-east-1:111111111111:certificate/abc',
    });
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    expect(dist.Properties.DistributionConfig.Aliases).toEqual(['vault.example.com']);
    expect(dist.Properties.DistributionConfig.ViewerCertificate.AcmCertificateArn)
      .toContain('certificate/abc');
  });

  it('creates the budget when an alert email is set', () => {
    synth().resourceCountIs('AWS::Budgets::Budget', 1);
  });
});