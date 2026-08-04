# Vaultwarden Serverless CDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a single-user Vaultwarden instance to AWS from one CDK stack, running at $0.00/month for the first year and roughly $0.18/month afterwards.

**Architecture:** CloudFront with Origin Access Control fronts an IAM-authenticated Lambda Function URL, so the function cannot be invoked directly from the internet. The function runs the official Vaultwarden container unmodified, with the AWS Lambda Web Adapter as an `/opt/extensions` sidecar translating Lambda invocations into HTTP. State lives on an EFS One Zone filesystem mounted at `/mnt/data`; a nightly Python function takes a consistent SQLite online backup and gzips it to S3.

**Tech Stack:** AWS CDK 2.263.0 (TypeScript), Node.js 24, jest + ts-jest with `aws-cdk-lib/assertions`, Python 3.12 for the backup function, pytest for its unit tests.

**Spec:** `docs/superpowers/specs/2026-08-04-vaultwarden-serverless-design.md`

## Global Constraints

These apply to every task.

- Region is `eu-west-1`. Account comes from `CDK_DEFAULT_ACCOUNT`.
- `aws-cdk-lib` pinned to `2.263.0`, `aws-cdk` CLI to `2.1135.0`, `constructs` `^10.0.0`.
- Lambda architecture is **`arm64`** everywhere.
- `ENABLE_DB_WAL=false` must be present on the application function from its very first boot. Without it the container aborts with `Failed to turn on WAL` on EFS, and a single startup without it writes WAL mode into the database file permanently.
- `ADMIN_TOKEN` must **never** appear in any environment map. Its absence is what disables `/admin`.
- The EFS filesystem and the backup bucket both use `RemovalPolicy.RETAIN`. A `cdk destroy` must never be able to delete the vault or its backups.
- No NAT Gateway, no interface VPC endpoints, no WAF, no Route 53, no Secrets Manager. Each of these costs more than the entire rest of the stack.
- Never use the deprecated `logRetention` prop on Lambda functions. Create an explicit `logs.LogGroup` and pass it via `logGroup`.
- Commit after every task. Conventional Commits format.

## Prerequisites

Node.js 24 and npm 11 are installed. `aws-cdk-lib` 2.263.0 is current.

**No container runtime is installed on this machine.** Tasks 1–6 do not need one: at synthesis time CDK only hashes the Docker asset directory, so `cdk synth` and all assertion tests run without it. Task 7 (deployment) requires Docker Desktop, Colima, or Podman.

## File Structure

| File | Responsibility |
|---|---|
| `bin/vaultwarden.ts` | CDK app entry point; reads context, sets env |
| `lib/vaultwarden-stack.ts` | Wires the four constructs together, declares outputs |
| `lib/constructs/storage.ts` | VPC, S3 gateway endpoint, EFS filesystem + access point, backup bucket |
| `lib/constructs/application.ts` | Container function, log group, Function URL, CloudFront distribution |
| `lib/constructs/backup.ts` | Python function, EventBridge schedule, IAM grants |
| `lib/constructs/cost-guard.ts` | AWS Budgets alert |
| `docker/vaultwarden/Dockerfile` | Official image plus Lambda Web Adapter |
| `lambda/backup/index.py` | SQLite online backup, gzip, upload |
| `lambda/backup/test_index.py` | pytest unit tests for the backup logic |
| `test/*.test.ts` | One assertion test file per construct |
| `README.md` | Deployment runbook, restore procedure, owner obligations |

Constructs are split by responsibility with a one-way dependency chain: `storage` exposes the VPC, access point and bucket; `application` consumes the first two; `backup` consumes all three. Nothing depends on `application`, which keeps the CloudFormation graph acyclic.

---

### Task 1: Project scaffolding and empty stack

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `cdk.json`, `.gitignore` (already exists — extend)
- Create: `bin/vaultwarden.ts`, `lib/vaultwarden-stack.ts`
- Test: `test/stack.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class VaultwardenStack extends cdk.Stack` exported from `lib/vaultwarden-stack.ts`, constructed as `new VaultwardenStack(app, id, props)` where `props` is `cdk.StackProps`.

- [ ] **Step 1: Initialise the package**

```bash
npm init -y
npm pkg set name="vaultwarden-cdk" version="0.1.0" private=true
npm pkg set scripts.build="tsc" scripts.test="jest" scripts.synth="cdk synth"
npm install --save-exact aws-cdk-lib@2.263.0
npm install constructs@^10.0.0
npm install --save-dev --save-exact aws-cdk@2.1135.0
npm install --save-dev typescript @types/node @types/jest jest ts-jest ts-node
```

- [ ] **Step 2: Write the config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "declaration": true,
    "types": ["node", "jest"]
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "cdk.out"]
}
```

`jest.config.js`:
```js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
};
```

`cdk.json`:
```json
{
  "app": "npx ts-node --prefer-ts-exts bin/vaultwarden.ts",
  "context": {
    "vaultwarden:domain": "https://localhost",
    "vaultwarden:alertEmail": "",
    "vaultwarden:imageTag": "1.35.1-alpine",
    "@aws-cdk/core:newStyleStackSynthesis": true
  }
}
```

`vaultwarden:domain` deliberately starts as a placeholder. The real CloudFront URL is not known until the distribution exists — see Task 7.

- [ ] **Step 3: Write the failing test**

`test/stack.test.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VaultwardenStack } from '../lib/vaultwarden-stack';

function synth(): Template {
  const app = new cdk.App({ context: { 'vaultwarden:alertEmail': 'test@example.com' } });
  const stack = new VaultwardenStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'eu-west-1' },
  });
  return Template.fromStack(stack);
}

describe('VaultwardenStack', () => {
  it('synthesises without error', () => {
    expect(() => synth()).not.toThrow();
  });

  it('creates no NAT gateways', () => {
    synth().resourceCountIs('AWS::EC2::NatGateway', 0);
  });
});

export { synth };
```

The second test fails now and keeps passing for the rest of the plan. It is the single most expensive mistake this stack can make ($32.85/month), so it is asserted from the first commit.

- [ ] **Step 4: Run the test and confirm it fails**

Run: `npx jest test/stack.test.ts`
Expected: FAIL — `Cannot find module '../lib/vaultwarden-stack'`

- [ ] **Step 5: Write the minimal stack**

`lib/vaultwarden-stack.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class VaultwardenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
```

`bin/vaultwarden.ts`:
```ts
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VaultwardenStack } from '../lib/vaultwarden-stack';

const app = new cdk.App();

new VaultwardenStack(app, 'VaultwardenStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' },
  description: 'Single-user self-hosted Vaultwarden on Lambda, EFS and CloudFront',
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npx jest`
Expected: PASS, 2 tests.

- [ ] **Step 7: Confirm synthesis works end to end**

Run: `npx cdk synth`
Expected: YAML for an empty stack, no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold CDK app with empty stack and test harness"
```

---

### Task 2: Storage construct

**Files:**
- Create: `lib/constructs/storage.ts`
- Modify: `lib/vaultwarden-stack.ts`
- Test: `test/storage.test.ts`

**Interfaces:**
- Consumes: `VaultwardenStack` from Task 1
- Produces:
  ```ts
  export class Storage extends Construct {
    readonly vpc: ec2.Vpc;
    readonly fileSystem: efs.FileSystem;
    readonly accessPoint: efs.AccessPoint;
    readonly backupBucket: s3.Bucket;
  }
  ```
  Constructed as `new Storage(this, 'Storage')` — no props.

- [ ] **Step 1: Write the failing tests**

`test/storage.test.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Storage } from '../lib/constructs/storage';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  new Storage(stack, 'Storage');
  return Template.fromStack(stack);
}

describe('Storage', () => {
  it('creates no NAT gateways and no internet gateway', () => {
    const t = synth();
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::EC2::InternetGateway', 0);
  });

  it('creates exactly one isolated subnet', () => {
    synth().resourceCountIs('AWS::EC2::Subnet', 1);
  });

  it('reaches S3 through a free gateway endpoint, not an interface endpoint', () => {
    const t = synth();
    t.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  });

  it('creates a One Zone, bursting, encrypted filesystem', () => {
    synth().hasResourceProperties('AWS::EFS::FileSystem', {
      ThroughputMode: 'bursting',
      PerformanceMode: 'generalPurpose',
      Encrypted: true,
      AvailabilityZoneName: Match.anyValue(),
    });
  });

  it('sets no lifecycle policy, so no per-access Infrequent Access charges', () => {
    synth().hasResourceProperties('AWS::EFS::FileSystem', {
      LifecyclePolicies: Match.absent(),
    });
  });

  it('retains the filesystem and the bucket on stack deletion', () => {
    const t = synth();
    t.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Retain' });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  it('restricts filesystem access to in-account traffic arriving via a mount target', () => {
    synth().hasResourceProperties('AWS::EFS::FileSystemPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite']),
            Condition: Match.objectLike({
              Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
            }),
          }),
        ]),
      }),
    });
  });

  it('never grants root access to the filesystem', () => {
    const policies = synth().findResources('AWS::EFS::FileSystemPolicy');
    expect(JSON.stringify(policies)).not.toContain('ClientRootAccess');
  });

  it('exposes the data directory through a non-root POSIX access point', () => {
    synth().hasResourceProperties('AWS::EFS::AccessPoint', {
      PosixUser: { Uid: '1000', Gid: '1000' },
      RootDirectory: Match.objectLike({
        Path: '/vaultwarden',
        CreationInfo: { OwnerUid: '1000', OwnerGid: '1000', Permissions: '0755' },
      }),
    });
  });

  it('versions the backup bucket, blocks public access and requires TLS', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      }),
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('expires backups and old versions after 90 days', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            ExpirationInDays: 90,
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          }),
        ]),
      },
    });
  });
});
```

`SSEAlgorithm: 'AES256'` is asserted deliberately: switching to KMS would add roughly $1/month in key charges, several times the entire stack budget.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest test/storage.test.ts`
Expected: FAIL — `Cannot find module '../lib/constructs/storage'`

- [ ] **Step 3: Implement the construct**

`lib/constructs/storage.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Network and persistent state.
 *
 * One AZ is deliberate: it avoids cross-AZ data charges and is what makes the
 * EFS One Zone storage class available, at half the price of Standard. The
 * availability risk is covered by the nightly backup to S3.
 */
export class Storage extends Construct {
  readonly vpc: ec2.Vpc;
  readonly fileSystem: efs.FileSystem;
  readonly accessPoint: efs.AccessPoint;
  readonly backupBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // PRIVATE_ISOLATED produces no Internet Gateway and no NAT Gateway. The
    // application needs no outbound internet, and a NAT Gateway alone would
    // cost $32.85/month.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/24'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 },
      ],
    });

    // Gateway endpoints are free; the interface variety is $7.30/month each.
    // Without this the backup function cannot reach S3 from an isolated subnet.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.backupBucket = new s3.Bucket(this, 'Backups', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        id: 'expire-old-backups',
        enabled: true,
        expiration: cdk.Duration.days(90),
        noncurrentVersionExpiration: cdk.Duration.days(90),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.fileSystem = new efs.FileSystem(this, 'Data', {
      vpc: this.vpc,
      oneZone: true,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      // BURSTING has no per-GB charge. ELASTIC would bill $0.03/GB read and
      // $0.06/GB write.
      throughputMode: efs.ThroughputMode.BURSTING,
      // No lifecycle policy on purpose: Infrequent Access is cheaper per GB but
      // bills per access, and at ~50 MB the saving is zero.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemPolicy: new iam.PolicyDocument({
        statements: [
          // Scoped by account and by mount-target arrival rather than by role
          // ARN. Naming the roles here would create a circular dependency with
          // the constructs that create them.
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
            conditions: {
              Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' },
              StringEquals: { 'aws:PrincipalAccount': cdk.Stack.of(this).account },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['*'],
            conditions: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ],
      }),
    });

    this.accessPoint = this.fileSystem.addAccessPoint('DataAccessPoint', {
      path: '/vaultwarden',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0755' },
      posixUser: { uid: '1000', gid: '1000' },
    });
  }
}
```

`ClientRootAccess` is never granted. Combined with the access point's POSIX user, a compromised function cannot escape `/vaultwarden`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest test/storage.test.ts`
Expected: PASS, 10 tests.

If `oneZone: true` raises a synthesis error about subnet selection, the cause is CDK selecting a default subnet group that does not exist in this VPC. Fix by passing `vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }` alongside `oneZone`. If CDK rejects that combination too, fall back to `oneZone: false` and record the $0.14/month difference in the README. Do not silently drop the assertion.

- [ ] **Step 5: Wire it into the stack**

In `lib/vaultwarden-stack.ts`, inside the constructor:
```ts
const storage = new Storage(this, 'Storage');
```
Add the import, and mark it used with a temporary `void storage;` if `noUnusedLocals` complains — Task 3 consumes it.

- [ ] **Step 6: Run the full suite and synthesise**

Run: `npx jest && npx cdk synth`
Expected: PASS, and clean synthesis.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add storage construct with isolated VPC and One Zone EFS"
```

---

### Task 3: Container image definition

**Files:**
- Create: `docker/vaultwarden/Dockerfile`
- Test: `test/dockerfile.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a build context at `docker/vaultwarden/` consumed by Task 4 via `lambda.DockerImageCode.fromImageAsset`.

A test on a Dockerfile is unusual, but two of these lines are load-bearing and silently breakable: the port override and the readiness path. A regression in either produces a function that times out on every request with no useful error.

- [ ] **Step 1: Write the failing test**

`test/dockerfile.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = () =>
  readFileSync(join(__dirname, '..', 'docker', 'vaultwarden', 'Dockerfile'), 'utf8');

describe('Vaultwarden Dockerfile', () => {
  it('builds on the official image without modifying its sources', () => {
    expect(dockerfile()).toMatch(/^FROM vaultwarden\/server:/m);
    expect(dockerfile()).not.toMatch(/cargo build/);
  });

  it('installs the Lambda Web Adapter as an extension', () => {
    expect(dockerfile()).toContain(
      'COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter',
    );
  });

  it('overrides the image default port of 80 and matches the adapter to it', () => {
    const text = dockerfile();
    expect(text).toMatch(/AWS_LWA_PORT=8080/);
    expect(text).toMatch(/ROCKET_PORT=8080/);
  });

  it('points the readiness check at an endpoint Vaultwarden actually serves', () => {
    expect(dockerfile()).toMatch(/AWS_LWA_READINESS_CHECK_PATH=\/alive/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest test/dockerfile.test.ts`
Expected: FAIL — `ENOENT: no such file or directory`

- [ ] **Step 3: Write the Dockerfile**

`docker/vaultwarden/Dockerfile`:
```dockerfile
# Official image, unmodified. Upgrading is a tag change — unlike the lambda-web
# crate patch used by darioackermann/vaultwarden-serverless, which pins that
# project to a 2023 build of Vaultwarden.
FROM vaultwarden/server:1.35.1-alpine

# The adapter runs as a Lambda external extension and proxies invocations to the
# Rocket server over localhost. The public ECR image is multi-arch, so this one
# tag covers arm64.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter

# The official image defaults ROCKET_PORT to 80. Both sides must agree.
ENV ROCKET_PORT=8080 \
    ROCKET_ADDRESS=0.0.0.0 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/alive \
    AWS_LWA_ASYNC_INIT=true
```

`AWS_LWA_ASYNC_INIT` lets Vaultwarden keep initialising past the 10-second init deadline, which matters on a cold start that also has to mount EFS.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest test/dockerfile.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Vaultwarden container image with Lambda Web Adapter"
```

---

### Task 4: Application construct

**Files:**
- Create: `lib/constructs/application.ts`
- Modify: `lib/vaultwarden-stack.ts`
- Test: `test/application.test.ts`

**Interfaces:**
- Consumes: `Storage` from Task 2 (`vpc`, `fileSystem`, `accessPoint`), the Dockerfile from Task 3
- Produces:
  ```ts
  export interface ApplicationProps {
    readonly vpc: ec2.IVpc;
    readonly fileSystem: efs.FileSystem;
    readonly accessPoint: efs.AccessPoint;
    /** Absolute public URL. Placeholder on the first deploy — see Task 7. */
    readonly domain: string;
    /** Container image tag, e.g. "1.35.1-alpine". */
    readonly imageTag: string;
  }

  export class Application extends Construct {
    readonly handler: lambda.DockerImageFunction;
    readonly distribution: cloudfront.Distribution;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`test/application.test.ts`:
```ts
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

  it('reads the client IP from the header CloudFront actually sets', () => {
    expect(appFunction(synth()).Properties.Environment.Variables.IP_HEADER).toBe('X-Forwarded-For');
  });

  it('closes registration and disables features that need outbound internet', () => {
    const env = appFunction(synth()).Properties.Environment.Variables;
    expect(env.SIGNUPS_ALLOWED).toBe('false');
    expect(env.INVITATIONS_ALLOWED).toBe('false');
    expect(env.DISABLE_ICON_DOWNLOAD).toBe('true');
    expect(env.WEBSOCKET_ENABLED).toBe('false');
    expect(env.DATABASE_URL).toBe('/mnt/data/db.sqlite3');
    expect(env.DATA_FOLDER).toBe('/mnt/data');
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

  it('grants the function no permissions beyond EFS and logs', () => {
    const policies = synth().findResources('AWS::IAM::Policy');
    const text = JSON.stringify(policies);
    expect(text).not.toContain('secretsmanager:');
    expect(text).not.toContain('ssm:');
    expect(text).not.toContain('s3:PutObject');
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

  it('caches the four static asset prefixes so repeat loads bypass Lambda', () => {
    const dists = synth().findResources('AWS::CloudFront::Distribution');
    const behaviors = Object.values(dists)[0].Properties.DistributionConfig.CacheBehaviors;
    expect(behaviors.map((b: any) => b.PathPattern).sort())
      .toEqual(['/app/*', '/fonts/*', '/images/*', '/scripts/*']);
    for (const b of behaviors) {
      // CachingOptimized managed policy
      expect(b.CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6');
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest test/application.test.ts`
Expected: FAIL — `Cannot find module '../lib/constructs/application'`

- [ ] **Step 3: Implement the construct**

`lib/constructs/application.ts`:
```ts
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
        { platform: ecrAssets.Platform.LINUX_ARM64 },
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest test/application.test.ts`
Expected: PASS, 15 tests.

If the two managed-policy IDs do not match, read the actual value out of the synthesised template and correct the test — do not delete the assertion. These IDs pin behaviour that is invisible in the construct source.

- [ ] **Step 5: Wire it into the stack**

In `lib/vaultwarden-stack.ts`:
```ts
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
```

- [ ] **Step 6: Run the full suite and synthesise**

Run: `npx jest && npx cdk synth`
Expected: PASS, clean synthesis, `CdnDomainName` in the Outputs section.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add application function behind CloudFront with origin access control"
```

---

### Task 5: Backup function logic

**Files:**
- Create: `lambda/backup/index.py`, `lambda/backup/test_index.py`, `lambda/backup/requirements-dev.txt`
- Test: `lambda/backup/test_index.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `snapshot_database(db_path: str, dest_path: str) -> int` — writes a consistent copy of the SQLite database at `db_path` to `dest_path`, returns the byte size written.
  - `compress(src_path: str, dest_path: str) -> int` — gzips `src_path` to `dest_path`, returns the compressed byte size.
  - `backup_key(now: datetime) -> str` — returns the S3 object key.
  - `handler(event, context) -> dict` — the Lambda entry point.

This task is pure Python with no AWS involvement in the tested paths, so it is tested with pytest before any infrastructure references it.

- [ ] **Step 1: Write the failing tests**

`lambda/backup/test_index.py`:
```python
import gzip
import os
import sqlite3
from datetime import datetime, timezone

import pytest

import index


def make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE ciphers (id INTEGER PRIMARY KEY, data TEXT)")
    conn.executemany("INSERT INTO ciphers (data) VALUES (?)", [(f"row-{i}",) for i in range(100)])
    conn.commit()
    conn.close()


def test_snapshot_produces_a_readable_database_with_all_rows(tmp_path):
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")
    make_db(src)

    size = index.snapshot_database(src, dest)

    assert size > 0
    conn = sqlite3.connect(dest)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    conn.close()


def test_snapshot_is_consistent_while_a_writer_holds_an_open_transaction(tmp_path):
    """The whole reason for using the online backup API instead of copying the file."""
    src = str(tmp_path / "db.sqlite3")
    dest = str(tmp_path / "snap.sqlite3")
    make_db(src)

    writer = sqlite3.connect(src)
    writer.execute("BEGIN")
    writer.execute("INSERT INTO ciphers (data) VALUES ('uncommitted')")

    index.snapshot_database(src, dest)
    writer.rollback()
    writer.close()

    conn = sqlite3.connect(dest)
    assert conn.execute("SELECT COUNT(*) FROM ciphers").fetchone()[0] == 100
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()


def test_snapshot_rejects_a_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        index.snapshot_database(str(tmp_path / "absent.sqlite3"), str(tmp_path / "out"))


def test_compress_round_trips(tmp_path):
    src = tmp_path / "plain.bin"
    src.write_bytes(b"vaultwarden" * 5000)
    dest = str(tmp_path / "plain.bin.gz")

    size = index.compress(str(src), dest)

    assert size == os.path.getsize(dest)
    assert size < src.stat().st_size
    with gzip.open(dest, "rb") as fh:
        assert fh.read() == b"vaultwarden" * 5000


def test_backup_key_sorts_chronologically_as_a_string():
    early = index.backup_key(datetime(2026, 8, 4, 3, 0, 0, tzinfo=timezone.utc))
    later = index.backup_key(datetime(2026, 12, 4, 3, 0, 0, tzinfo=timezone.utc))

    assert early == "db/2026-08-04T03-00-00Z.sqlite3.gz"
    assert early < later
```

The second test is the point of the whole task. A plain file copy — which is what AWS Backup on EFS would do — can capture a database mid-write and produce an unusable file.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
python3 -m venv .venv
.venv/bin/pip install pytest boto3
cd lambda/backup && ../../.venv/bin/python -m pytest -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'index'`

Record the dev dependencies in `lambda/backup/requirements-dev.txt`:
```
pytest>=8
boto3>=1.34
```

- [ ] **Step 3: Implement the module**

`lambda/backup/index.py`:
```python
"""Nightly consistent backup of the Vaultwarden SQLite database to S3.

Uses SQLite's online backup API rather than copying the file. A copy taken while
Vaultwarden is mid-write yields a torn, unusable database; the backup API
produces a consistent snapshot without stopping writers.
"""

import gzip
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone

import boto3

DB_PATH = os.environ.get("DB_PATH", "/mnt/data/db.sqlite3")
BUCKET_NAME = os.environ.get("BUCKET_NAME", "")

_s3 = boto3.client("s3")


def snapshot_database(db_path: str, dest_path: str) -> int:
    """Write a consistent copy of the database to dest_path. Returns bytes written."""
    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)

    source = sqlite3.connect(db_path)
    try:
        dest = sqlite3.connect(dest_path)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()

    return os.path.getsize(dest_path)


def compress(src_path: str, dest_path: str) -> int:
    """Gzip src_path to dest_path. Returns the compressed size in bytes."""
    with open(src_path, "rb") as raw, gzip.open(dest_path, "wb") as archive:
        shutil.copyfileobj(raw, archive)
    return os.path.getsize(dest_path)


def backup_key(now: datetime) -> str:
    """S3 key for a backup taken at `now`. Lexical order matches chronological order."""
    return f"db/{now.strftime('%Y-%m-%dT%H-%M-%SZ')}.sqlite3.gz"


def handler(event, context):  # noqa: ARG001 - Lambda signature
    if not os.path.exists(DB_PATH):
        # Expected between stack creation and first login.
        return {"status": "skipped", "reason": "database does not exist yet"}

    key = backup_key(datetime.now(timezone.utc))

    # Lambda gives every invocation 512 MB of writable /tmp at no cost.
    with tempfile.TemporaryDirectory() as workdir:
        snapshot = os.path.join(workdir, "snapshot.sqlite3")
        archive = snapshot + ".gz"

        raw_size = snapshot_database(DB_PATH, snapshot)
        gz_size = compress(snapshot, archive)
        _s3.upload_file(archive, BUCKET_NAME, key)

    return {"status": "ok", "key": key, "bytes": raw_size, "compressed": gz_size}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd lambda/backup && ../../.venv/bin/python -m pytest -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Exclude the virtualenv from git and from the Lambda asset**

Append to `.gitignore`:
```
.venv/
__pycache__/
.pytest_cache/
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add SQLite online backup routine for the nightly job"
```

---

### Task 6: Backup infrastructure and cost guard

**Files:**
- Create: `lib/constructs/backup.ts`, `lib/constructs/cost-guard.ts`
- Modify: `lib/vaultwarden-stack.ts`
- Test: `test/backup.test.ts`

**Interfaces:**
- Consumes: `Storage` from Task 2, `lambda/backup/index.py` from Task 5
- Produces:
  ```ts
  export interface BackupProps {
    readonly vpc: ec2.IVpc;
    readonly fileSystem: efs.FileSystem;
    readonly accessPoint: efs.AccessPoint;
    readonly bucket: s3.IBucket;
  }
  export class Backup extends Construct { readonly handler: lambda.Function; }

  export interface CostGuardProps {
    readonly monthlyLimitUsd: number;
    readonly notifyEmail: string;
  }
  export class CostGuard extends Construct {}
  ```

- [ ] **Step 1: Write the failing tests**

`test/backup.test.ts`:
```ts
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Backup } from '../lib/constructs/backup';
import { CostGuard } from '../lib/constructs/cost-guard';
import { Storage } from '../lib/constructs/storage';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'S', { env: { account: '111111111111', region: 'eu-west-1' } });
  const storage = new Storage(stack, 'Storage');
  new Backup(stack, 'Backup', {
    vpc: storage.vpc,
    fileSystem: storage.fileSystem,
    accessPoint: storage.accessPoint,
    bucket: storage.backupBucket,
  });
  new CostGuard(stack, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: 'test@example.com' });
  return Template.fromStack(stack);
}

function backupFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden-backup');
  expect(match).toBeDefined();
  return match;
}

describe('Backup', () => {
  it('runs nightly at 03:00 UTC', () => {
    synth().hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 3 * * ? *)',
      State: 'ENABLED',
    });
  });

  it('runs on arm64 Python 3.12 and mounts the same EFS path', () => {
    const fn = backupFunction(synth()).Properties;
    expect(fn.Architectures).toEqual(['arm64']);
    expect(fn.Runtime).toBe('python3.12');
    expect(fn.FileSystemConfigs[0].LocalMountPath).toBe('/mnt/data');
    expect(fn.Environment.Variables.DB_PATH).toBe('/mnt/data/db.sqlite3');
  });

  it('may write backups but may not read or delete them', () => {
    const text = JSON.stringify(synth().findResources('AWS::IAM::Policy'));
    expect(text).toContain('s3:PutObject');
    expect(text).not.toContain('s3:DeleteObject');
    expect(text).not.toContain('s3:GetObject');
  });

  it('caps its own concurrency so a schedule storm cannot run away', () => {
    expect(backupFunction(synth()).Properties.ReservedConcurrentExecutions).toBe(1);
  });
});

describe('CostGuard', () => {
  it('alerts once monthly spend is forecast to exceed the limit', () => {
    synth().hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
    });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest test/backup.test.ts`
Expected: FAIL — `Cannot find module '../lib/constructs/backup'`

- [ ] **Step 3: Implement the backup construct**

`lib/constructs/backup.ts`:
```ts
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
```

`grantPut` issues `s3:PutObject` and `s3:AbortMultipartUpload` only, which is why the test asserts `GetObject` and `DeleteObject` are absent.

- [ ] **Step 4: Implement the cost guard**

`lib/constructs/cost-guard.ts`:
```ts
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';

export interface CostGuardProps {
  readonly monthlyLimitUsd: number;
  readonly notifyEmail: string;
}

/**
 * The first two budgets per account are free. This is the backstop for the
 * whole cost model: if anything in this stack starts billing, it says so before
 * the month ends.
 */
export class CostGuard extends Construct {
  constructor(scope: Construct, id: string, props: CostGuardProps) {
    super(scope, id);

    new budgets.CfnBudget(this, 'Monthly', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyLimitUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [{
        notification: {
          notificationType: 'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold: 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.notifyEmail }],
      }],
    });
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx jest test/backup.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Wire both into the stack**

In `lib/vaultwarden-stack.ts`:
```ts
new Backup(this, 'Backup', {
  vpc: storage.vpc,
  fileSystem: storage.fileSystem,
  accessPoint: storage.accessPoint,
  bucket: storage.backupBucket,
});

const alertEmail = this.node.tryGetContext('vaultwarden:alertEmail');
if (alertEmail) {
  new CostGuard(this, 'CostGuard', { monthlyLimitUsd: 1, notifyEmail: alertEmail });
}

new cdk.CfnOutput(this, 'BackupBucketName', { value: storage.backupBucket.bucketName });
```

The budget is conditional because `CfnBudget` rejects an empty subscriber address, and `cdk.json` ships with the email blank.

- [ ] **Step 7: Run the full suite and synthesise**

Run: `npx jest && npx cdk synth`
Expected: PASS, all tests across all files. Clean synthesis.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add nightly backup job and monthly budget alert"
```

---

### Task 7: Deployment runbook

**Files:**
- Create: `README.md`
- Test: manual, following the runbook

This task has no automated test. Its deliverable is a document that a person follows once, and the verification is that the deployment works.

- [ ] **Step 1: Write the README**

`README.md` must contain, in this order:

1. **What this is** — one paragraph, and a link to the spec.
2. **Cost** — the table from spec §4.
3. **Prerequisites** — Node 24, AWS credentials, and the container runtime requirement, noting that `npm test` works without one but `cdk deploy` does not.
4. **First deployment**, as numbered commands:
   ```bash
   npm ci
   npm test
   npx cdk bootstrap aws://<ACCOUNT>/eu-west-1
   npx cdk deploy                      # DOMAIN is still the placeholder
   # Copy CdnDomainName from the outputs into cdk.json as vaultwarden:domain,
   # and set vaultwarden:alertEmail while you are there.
   npx cdk deploy                      # second pass applies the real DOMAIN
   ```
   Explain why two passes are needed: the CloudFront domain does not exist until the distribution is created, and feeding it back into the function's environment in one pass would make the CloudFormation dependency graph circular. Later deployments are single-pass.
5. **First login** — open the CloudFront URL, create the account, then immediately:
   - enable TOTP two-step login using a **separate** authenticator app, not the vault's own,
   - write the recovery code on paper and store it away from the phone,
   - confirm `SIGNUPS_ALLOWED` is `false` (it already is) and that `/admin` returns 404.
6. **Verifying the endpoint is closed** — `curl` the raw Function URL directly and confirm a 403:
   ```bash
   FN_URL=$(aws lambda get-function-url-config --function-name vaultwarden \
     --region eu-west-1 --query FunctionUrl --output text)
   curl -s -o /dev/null -w '%{http_code}\n' "$FN_URL"   # expect 403
   ```
7. **Testing the restore** — spec §8, with the explicit warning that an untested backup is not a backup, and that this must be done once before the vault holds anything the owner cannot afford to lose.
8. **Upgrading Vaultwarden** — change `vaultwarden:imageTag` in `cdk.json`, run `npx cdk deploy`. Never remove `ENABLE_DB_WAL=false`.
9. **Known limitations** — spec §6, verbatim.
10. **Security notes** — spec §5.4 and §5.5, verbatim, including the 2FA lockout escape hatch.

- [ ] **Step 2: Verify the README's commands against the code**

Confirm each command references names that exist: `vaultwarden` and `vaultwarden-backup` function names, the `CdnDomainName` and `BackupBucketName` outputs, and the `vaultwarden:domain`, `vaultwarden:alertEmail` and `vaultwarden:imageTag` context keys.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: add deployment runbook and restore procedure"
```

- [ ] **Step 4: Deploy** *(requires a container runtime — see Prerequisites)*

Follow the README. After the second pass, check:
- the CloudFront URL serves the web vault,
- the raw Function URL returns 403,
- `aws logs tail /aws/lambda/vaultwarden --region eu-west-1` shows no `Failed to turn on WAL`,
- manually invoking `vaultwarden-backup` writes an object under `db/` in the bucket.

- [ ] **Step 5: Test the restore before storing real passwords**

Follow spec §8 end to end. Confirm the restored database opens and `PRAGMA integrity_check` returns `ok`.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §3.1 networking → Task 2; §3.2 storage → Task 2; §3.3 function → Tasks 3 and 4; §3.4 environment → Task 4; §3.5 CloudFront → Task 4; §3.6 backup → Tasks 5 and 6; §4 cost guardrails → Task 6; §5 security → asserted across Tasks 2, 4 and 6, documented in Task 7; §6 limitations → Task 7; §7 two-pass deployment → Tasks 1 and 7; §8 restore → Task 7; §9 layout → the File Structure table.

**Placeholders.** None. Every code step carries the actual code, every test step the actual assertions.

**Type consistency.** `Storage` exposes `vpc`, `fileSystem`, `accessPoint`, `backupBucket`; Tasks 4 and 6 consume exactly those names. Both function constructs expose `handler`. `MOUNT_PATH` is `/mnt/data` in both. `DATABASE_URL` and `DB_PATH` both resolve to `/mnt/data/db.sqlite3`.

**Two known deviations from the spec, both deliberate:**

1. The spec describes an EFS filesystem policy naming the two Lambda roles. Task 2 scopes by account and mount-target arrival instead, because naming roles created by later constructs would make the CloudFormation graph circular. The security property — reachable only from inside this VPC, by this account, never as root — is preserved.
2. The spec describes a bucket policy denying all principals except the backup role. Task 2 uses `enforceSSL` plus a least-privilege identity grant instead. An explicit `NotPrincipal` deny is a well-known way to lock an account out of its own bucket, and it would block the restore procedure in §8.
