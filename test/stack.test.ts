import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { VaultwardenStack } from '../lib/vaultwarden-stack';

function build(context: Record<string, unknown> = {}): cdk.Stack {
  const app = new cdk.App({ context: { 'vaultwarden:alertEmail': 'test@example.com', ...context } });
  return new VaultwardenStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'eu-west-1' },
  });
}

function synth(context: Record<string, unknown> = {}): Template {
  return Template.fromStack(build(context));
}

function appFunction(t: Template): any {
  const fns = t.findResources('AWS::Lambda::Function');
  const match = Object.values(fns).find((f: any) => f.Properties.FunctionName === 'vaultwarden');
  expect(match).toBeDefined();
  return match;
}

describe('VaultwardenStack', () => {
  it('synthesises without error', () => {
    expect(() => synth()).not.toThrow();
  });

  it('creates no NAT gateways', () => {
    synth().resourceCountIs('AWS::EC2::NatGateway', 0);
  });
});

// SIGNUPS_ALLOWED is the one setting that is both a security control and a
// bootstrap requirement: Vaultwarden 1.35.1 admits a registration only when an
// invitation exists or signups are open (src/api/core/accounts.rs), and with no
// ADMIN_TOKEN and no SMTP there is no way to issue an invitation — so the owner
// account can only ever be created during a deploy that has this open.
describe('Registration bootstrap', () => {
  it('closes registration by default, so the steady state is a closed server', () => {
    expect(appFunction(synth()).Properties.Environment.Variables.SIGNUPS_ALLOWED).toBe('false');
  });

  it('opens registration when the context key says so, for the pass-1 bootstrap deploy', () => {
    const t = synth({ 'vaultwarden:signupsAllowed': 'true' });
    expect(appFunction(t).Properties.Environment.Variables.SIGNUPS_ALLOWED).toBe('true');
  });

  it('treats a JSON true in cdk.json the same as the CLI string', () => {
    const t = synth({ 'vaultwarden:signupsAllowed': true });
    expect(appFunction(t).Properties.Environment.Variables.SIGNUPS_ALLOWED).toBe('true');
  });

  it('fails closed on any other value, rather than opening the server on a typo', () => {
    for (const value of ['yes', 'TRUE', '1', '']) {
      const t = synth({ 'vaultwarden:signupsAllowed': value });
      expect(appFunction(t).Properties.Environment.Variables.SIGNUPS_ALLOWED).toBe('false');
    }
  });

  it('still never sets ADMIN_TOKEN by default — the bootstrap does not open /admin', () => {
    const t = synth({ 'vaultwarden:signupsAllowed': 'true' });
    expect(appFunction(t).Properties.Environment.Variables).not.toHaveProperty('ADMIN_TOKEN');
  });
});

// The alert address gates BOTH the backup-failure alarm and the budget, and
// cdk.json ships it blank. Composed with the bucket's 90-day expiry, a silent
// default means a backup that starts failing is invisible until the last good
// snapshot has already expired. The conditional is correct; the silence is not.
describe('Alerting prerequisite', () => {
  it('warns at synth time when no alert email is configured, naming what is lost', () => {
    const stack = build({ 'vaultwarden:alertEmail': '' });

    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('vaultwarden:alertEmail is not set'),
    );

    // The warning must be specific enough to act on, not a generic nudge.
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.anyValue());
    const text = JSON.stringify(warnings);
    expect(text).toContain('alarm');
    expect(text).toContain('Budgets');
    expect(text).toContain('90 days');

    // And the warning is telling the truth about what the template contains.
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it('does not warn when an alert email is configured, and creates the alarm and budget', () => {
    const stack = build();

    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('vaultwarden:alertEmail is not set'),
    );

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'test@example.com',
    });
  });
});

export { synth };
