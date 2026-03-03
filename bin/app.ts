#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DemoStack } from '../lib/demo-stack';

const app = new cdk.App();

new DemoStack(app, 'StackformDemoStack', {
  description: 'Stackform Demo — Lambda, Step Functions, API Gateway, DynamoDB, SQS, Next.js',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
