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

    // AWS Backup on EFS is deliberately not used (design spec §3.6): it copies
    // the file in whatever state it finds it, so a snapshot taken mid-write
    // produces an unusable database. The nightly SQLite online backup to S3 is
    // the backup story here, and AWS Backup would additionally be an unbudgeted
    // recurring charge against a ~$0.18/month stack.
    //
    // It has to be turned off explicitly, and it has to be done through an
    // escape hatch, for two separate reasons:
    //
    //  1. CreateFileSystem's automatic-backup default is `false` *except* when
    //     AvailabilityZoneName is specified — which oneZone: true does. So the
    //     One Zone storage class silently opts this filesystem in.
    //  2. aws-cdk-lib 2.263.0 maps the L2 prop as
    //     `props.enableAutomaticBackups ? { status: 'ENABLED' } : undefined`,
    //     so passing `enableAutomaticBackups: false` emits nothing at all and
    //     leaves the inverted service-side default in force.
    //
    // Setting BackupPolicy on the L1 is the only way to actually say DISABLED.
    (this.fileSystem.node.defaultChild as efs.CfnFileSystem).backupPolicy = {
      status: 'DISABLED',
    };

    this.accessPoint = this.fileSystem.addAccessPoint('DataAccessPoint', {
      path: '/vaultwarden',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0755' },
      posixUser: { uid: '1000', gid: '1000' },
    });
  }
}
