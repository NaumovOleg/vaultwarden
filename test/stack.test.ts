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
