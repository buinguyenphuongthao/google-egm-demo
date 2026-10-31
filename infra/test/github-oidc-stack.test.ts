import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const repo = 'buinguyenphuongthao/google-egm-demo';
const template = Template.fromStack(new GithubOidcStack(new App(), 'test-oidc', { repo }));

describe('GithubOidcStack', () => {
  it('trusts only the staging and prod environments of this repo', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': [
                  `repo:${repo}:environment:staging`,
                  `repo:${repo}:environment:prod`,
                ],
              },
            },
          }),
        ],
      },
    });
  });

  it('can only assume CDK bootstrap roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('role/cdk-hnb659fds-\\*')])]),
            }),
          }),
        ],
      },
    });
  });

  it('outputs the role ARN', () => {
    template.hasOutput('DeployRoleArn', {});
  });
});
