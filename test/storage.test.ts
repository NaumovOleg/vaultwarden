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

  // aws-cdk-lib 2.263.0's efs.FileSystem embeds `fileSystemPolicy` directly as
  // the `FileSystemPolicy` property of the `AWS::EFS::FileSystem` resource; it
  // does not synthesize a separate `AWS::EFS::FileSystemPolicy` resource. These
  // two assertions target the actual resource/property shape rather than the
  // one described in the task brief.
  it('restricts filesystem access to in-account traffic arriving via a mount target', () => {
    synth().hasResourceProperties('AWS::EFS::FileSystem', {
      FileSystemPolicy: Match.objectLike({
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
    const fileSystems = synth().findResources('AWS::EFS::FileSystem');
    expect(JSON.stringify(fileSystems)).not.toContain('ClientRootAccess');
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
