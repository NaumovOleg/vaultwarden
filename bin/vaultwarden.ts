#!/usr/bin/env node
import "dotenv/config";

import * as cdk from "aws-cdk-lib";
import { VaultwardenStack } from "../lib/vaultwarden-stack";

const app = new cdk.App();

// The region must be concrete, never undefined, so an environment-agnostic
// stack fails at synth with an error that does not mention the missing variable.
const region =
  process.env.DEFAULT_REGION ?? process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const account = process.env.DEFAULT_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT;

new VaultwardenStack(app, "VaultwardenStack", {
  env: { account, region },
  description:
    "Multi-user Bitwarden-compatible server on Lambda, DynamoDB, S3 and CloudFront",
});
