#!/usr/bin/env node
import "dotenv/config";

import * as cdk from "aws-cdk-lib";
import { VaultwardenStack } from "../lib/vaultwarden-stack";

const app = new cdk.App();

// The region must be concrete, never undefined. EFS One Zone needs a real
// availability zone, so an environment-agnostic stack fails at synth with an
// error that does not mention the missing variable.
const region =
  process.env.DEFAULT_REGION ?? process.env.CDK_DEFAULT_REGION ?? "eu-west-1";
const account = process.env.DEFAULT_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT;

new VaultwardenStack(app, "VaultwardenStack", {
  env: { account, region },
  description:
    "Single-user self-hosted Vaultwarden on Lambda, EFS and CloudFront",
});
