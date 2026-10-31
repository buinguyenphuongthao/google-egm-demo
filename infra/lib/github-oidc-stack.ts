import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  /** owner/name */
  repo: string;
  /** An AWS account has one GitHub OIDC provider; reuse it if it already exists. */
  existingProviderArn?: string;
}

/**
 * Deployed once, manually, by a human. CI never deploys this stack.
 * Branch restriction (main only) is enforced by the GitHub Environments' deployment
 * branch policies, because environment-scoped OIDC subjects do not include the branch.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const provider = props.existingProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubProvider', props.existingProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'egm-github-deploy',
      description: 'GitHub Actions deploy role for google-egm-demo - staging and prod environments only',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.repo}:environment:staging`,
            `repo:${props.repo}:environment:prod`,
          ],
        },
      }),
    });

    // All real permissions come from the CDK bootstrap roles that `cdk deploy` assumes.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
