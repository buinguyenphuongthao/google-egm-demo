import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface AppStackProps extends StackProps {
  stage: 'staging' | 'prod';
  /** Git SHA; served by /api/health so smoke tests can confirm what is live. */
  version: string;
  webDistPath: string;
  apiEntry: string;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const table = new dynamodb.Table(this, 'Notes', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy,
    });

    // CloudFront sends this value to the API; the Lambda rejects requests without it,
    // which closes the public execute-api URL. Resolved by CloudFormation at deploy time.
    // Never rotate in place: only the Lambda re-resolves it each deploy, so the Distribution would
    // keep the old value and every API call would 403. To rotate, change the construct id.
    const originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Header value CloudFront sends so the API accepts only CloudFront traffic',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy,
    });
    const originVerify = originSecret.secretValue.unsafeUnwrap();

    const fn = new NodejsFunction(this, 'ApiFunction', {
      entry: props.apiEntry,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        VERSION: props.version,
        ORIGIN_VERIFY: originVerify,
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy }),
    });
    table.grantReadWriteData(fn);

    const api = new apigw.HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn),
    });
    const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    // apiEndpoint is https://<id>.execute-api.<region>.amazonaws.com; CloudFront wants the host.
    const apiDomain = Fn.select(2, Fn.split('/', api.apiEndpoint));
    const distribution = new cloudfront.Distribution(this, 'Site', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain, { customHeaders: { 'x-origin-verify': originVerify } }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(props.webDistPath)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Owner IPs (ip:<addr>) and the CI smoke token (smoke-token). Data is set by
    // `npm run access`, never by CDK or CI. Read by the owner-only edge function.
    const accessStore = new cloudfront.KeyValueStore(this, 'AccessStore', {
      comment: `Owner-only access list for ${props.stage}`,
    });
    accessStore.applyRemovalPolicy(removalPolicy);
    new CfnOutput(this, 'AccessStoreArn', { value: accessStore.keyValueStoreArn });

    new CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
