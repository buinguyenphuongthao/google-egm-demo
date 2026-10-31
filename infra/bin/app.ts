import { App } from 'aws-cdk-lib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStack } from '../lib/app-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = new App();
const version: string = app.node.tryGetContext('version') ?? 'dev';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const shared = {
  env,
  version,
  webDistPath: path.join(here, '../../web/dist'),
  apiEntry: path.join(here, '../../api/src/lambda.ts'),
};

new AppStack(app, 'egm-staging', { ...shared, stage: 'staging' });
new AppStack(app, 'egm-prod', { ...shared, stage: 'prod' });

new GithubOidcStack(app, 'egm-github-oidc', {
  env,
  repo: 'buinguyenphuongthao/google-egm-demo',
  existingProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
});
