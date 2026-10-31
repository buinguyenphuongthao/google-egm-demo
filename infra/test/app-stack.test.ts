import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack';

const here = path.dirname(fileURLToPath(import.meta.url));

function synth(stage: 'staging' | 'prod') {
  const webDistPath = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dist-'));
  fs.writeFileSync(path.join(webDistPath, 'index.html'), '<!doctype html>');
  const stack = new AppStack(new App(), `test-${stage}`, {
    stage,
    version: 'abc123',
    webDistPath,
    apiEntry: path.join(here, '../../api/src/lambda.ts'),
  });
  return Template.fromStack(stack);
}

const staging = synth('staging');
const prod = synth('prod');

describe('AppStack', () => {
  it('creates an on-demand table with TTL', () => {
    staging.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('enables point-in-time recovery only in prod', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    staging.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
  });

  it('injects the version into the API Lambda', () => {
    staging.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: Match.objectLike({ VERSION: 'abc123' }) },
    });
  });

  it('scopes the API Lambda role to its own table', () => {
    const policies = Object.values(staging.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes('ApiFunctionServiceRole'),
    );
    expect(policies).toHaveLength(1);
    for (const statement of policies[0]!.Properties.PolicyDocument.Statement) {
      for (const resource of [statement.Resource].flat()) {
        const text = JSON.stringify(resource);
        if (text.includes('AWS::NoValue')) continue;
        expect(resource).not.toBe('*');
        expect(text).toMatch(/Notes[0-9A-F]{8}/);
      }
    }
  });

  it('keeps the site bucket private', () => {
    staging.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('routes /api/* through CloudFront without caching', () => {
    staging.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]),
      }),
    });
  });

  it('throttles the HTTP API', () => {
    staging.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 },
    });
  });

  it('outputs the site URL', () => {
    staging.hasOutput('SiteUrl', {});
  });
});
