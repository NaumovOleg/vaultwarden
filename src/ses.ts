import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const client = new SESv2Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const source = process.env.SES_SOURCE ?? '';

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

// SES transport used by the lambda. Fails closed with a logged error so a
// broken mailer can never block an otherwise-fine request path.
export const sesMailer: Mailer = {
  async send(to: string, subject: string, body: string): Promise<void> {
    if (!source) throw new Error('SES_SOURCE is not configured');
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: source,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'utf-8' },
            Body: { Text: { Data: body, Charset: 'utf-8' } },
          },
        },
      }),
    );
  },
};