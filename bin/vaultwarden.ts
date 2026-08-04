#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { VaultwardenStack } from '../lib/vaultwarden-stack';

const app = new cdk.App();

new VaultwardenStack(app, 'VaultwardenStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' },
  description: 'Single-user self-hosted Vaultwarden on Lambda, EFS and CloudFront',
});
