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
