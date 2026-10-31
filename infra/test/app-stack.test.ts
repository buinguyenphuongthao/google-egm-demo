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

  it.each([['staging', staging], ['prod', prod]] as const)(
    '%s adds a Board table keyed by pk/sk with TTL and the Notes removal and PITR settings',
    (s, t) => {
      const tables = t.findResources('AWS::DynamoDB::Table');
      expect(Object.keys(tables)).toHaveLength(2);
      const boardIds = Object.keys(tables).filter((id) => id.startsWith('Board'));
      // Pinned: a different logical id would replace the deployed table and drop its data.
      expect(boardIds).toEqual(['Board47D7A2D0']);
      const board = tables[boardIds[0]!]!;
      expect(board.Properties).toMatchObject({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: s === 'prod' },
      });
      const notes = Object.entries(tables).find(([id]) => id.startsWith('Notes'))![1];
      expect(board.DeletionPolicy).toBe(notes.DeletionPolicy);
      // The retired Notes table stays, unchanged: same logical id and key schema.
      expect(Object.keys(tables).filter((id) => id.startsWith('Notes'))).toEqual(['Notes5BB3582F']);
      expect(notes.Properties.KeySchema).toEqual([{ AttributeName: 'id', KeyType: 'HASH' }]);
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ BOARD_TABLE_NAME: { Ref: boardIds[0] } }) },
      });
      // Nothing reads Notes any more.
      for (const fn of Object.values(t.findResources('AWS::Lambda::Function'))) {
        expect(fn.Properties.Environment?.Variables?.TABLE_NAME).toBeUndefined();
      }
    },
  );

  it('injects the version into the API Lambda', () => {
    staging.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: Match.objectLike({ VERSION: 'abc123' }) },
    });
  });

  it('scopes the API Lambda role to the Board table', () => {
    const policies = Object.values(staging.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes('ApiFunctionServiceRole'),
    );
    expect(policies).toHaveLength(1);
    for (const statement of policies[0]!.Properties.PolicyDocument.Statement) {
      for (const resource of [statement.Resource].flat()) {
        const text = JSON.stringify(resource);
        if (text.includes('AWS::NoValue')) continue;
        expect(resource).not.toBe('*');
        expect(text).toMatch(/Board[0-9A-F]{8}/);
        expect(text).not.toMatch(/Notes/);
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

  it.each([['staging', staging], ['prod', prod]] as const)(
    '%s locks the API origin to CloudFront with a Secrets Manager dynamic reference',
    (_s, t) => {
      t.resourceCountIs('AWS::SecretsManager::Secret', 1);
      const apiFns = Object.values(t.findResources('AWS::Lambda::Function')).filter(
        (f) => f.Properties.Environment?.Variables?.BOARD_TABLE_NAME !== undefined,
      );
      expect(apiFns).toHaveLength(1);
      const envValue = apiFns[0]!.Properties.Environment.Variables.ORIGIN_VERIFY;

      type Origin = {
        S3OriginConfig?: unknown;
        CustomOriginConfig?: unknown;
        OriginCustomHeaders?: { HeaderName: string; HeaderValue: unknown }[];
      };
      const [dist] = Object.values(t.findResources('AWS::CloudFront::Distribution'));
      const origins: Origin[] = dist!.Properties.DistributionConfig.Origins;
      const s3Origins = origins.filter((o) => o.S3OriginConfig !== undefined);
      const apiOrigins = origins.filter((o) => o.CustomOriginConfig !== undefined);
      expect(s3Origins).toHaveLength(1);
      expect(apiOrigins).toHaveLength(1);
      expect(s3Origins[0]!.OriginCustomHeaders).toBeUndefined();
      expect(apiOrigins[0]!.OriginCustomHeaders).toHaveLength(1);
      const header = apiOrigins[0]!.OriginCustomHeaders![0]!;
      expect(header.HeaderName).toBe('x-origin-verify');

      // Never a literal: a CloudFormation dynamic reference built from the secret's Ref.
      expect(typeof envValue).not.toBe('string');
      expect(JSON.stringify(envValue)).toContain('{{resolve:secretsmanager:');
      const [secretId] = Object.keys(t.findResources('AWS::SecretsManager::Secret'));
      expect(JSON.stringify(envValue)).toContain(JSON.stringify({ Ref: secretId }));
      expect(header.HeaderValue).toEqual(envValue);
    },
  );

  it.each([
    ['staging', staging, 'Delete'],
    ['prod', prod, 'Retain'],
  ] as const)('%s has an access KeyValueStore with deletion policy %s', (_s, t, policy) => {
    t.resourceCountIs('AWS::CloudFront::KeyValueStore', 1);
    t.hasResource('AWS::CloudFront::KeyValueStore', { DeletionPolicy: policy, UpdateReplacePolicy: policy });
    t.hasOutput('AccessStoreArn', {});
  });

  it.each([['staging', staging], ['prod', prod]] as const)(
    '%s attaches the owner-only function to every behavior and disables IPv6',
    (_s, t) => {
      const storeIds = Object.keys(t.findResources('AWS::CloudFront::KeyValueStore'));
      expect(storeIds).toHaveLength(1);
      const storeId = storeIds[0]!;
      // Logical id must keep the AccessStore prefix: a new id would replace the store and lose its data.
      // Pinned: a different logical id would replace the deployed store and drop its data.
      expect(storeId).toBe('AccessStore48D83FA1');

      t.resourceCountIs('AWS::CloudFront::Function', 1);
      const [fnId, fnRes] = Object.entries(t.findResources('AWS::CloudFront::Function'))[0]!;
      const config = fnRes.Properties.FunctionConfig;
      expect(config.Runtime).toBe('cloudfront-js-2.0');
      // The Distribution can only reference a published function.
      expect(fnRes.Properties.AutoPublish).toBe(true);
      expect(JSON.stringify(config.KeyValueStoreAssociations)).toContain(
        JSON.stringify({ 'Fn::GetAtt': [storeId, 'Arn'] }),
      );

      const code = JSON.stringify(fnRes.Properties.FunctionCode);
      expect(code).not.toContain('__KVS_ID__');
      expect(code).toContain('Fn::Join');
      expect(code).toContain(JSON.stringify({ 'Fn::GetAtt': [storeId, 'Id'] }));

      const [dist] = Object.values(t.findResources('AWS::CloudFront::Distribution'));
      const cfg = dist!.Properties.DistributionConfig;
      expect(cfg.IPV6Enabled).toBe(false);
      type Assoc = { EventType: string; FunctionARN: unknown };
      const behaviors: { FunctionAssociations?: Assoc[] }[] = [cfg.DefaultCacheBehavior, ...cfg.CacheBehaviors];
      expect(cfg.CacheBehaviors.length).toBeGreaterThan(0);
      for (const b of behaviors) {
        expect(b.FunctionAssociations).toHaveLength(1);
        expect(b.FunctionAssociations![0]!.EventType).toBe('viewer-request');
        expect(b.FunctionAssociations![0]!.FunctionARN).toEqual({ 'Fn::GetAtt': [fnId, 'FunctionARN'] });
      }
    },
  );

  it('outputs the site URL', () => {
    staging.hasOutput('SiteUrl', {});
  });
});
