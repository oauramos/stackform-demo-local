import * as path from 'path';
import { execSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class DemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB Table ──────────────────────────────────────────────────────
    const ddbTable = new dynamodb.Table(this, 'DemoTable', {
      tableName: 'StackformDemoItems',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── SQS Queue + DLQ ─────────────────────────────────────────────────────
    const dlq = new sqs.Queue(this, 'DemoDLQ', {
      queueName: 'StackformDemoDLQ',
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, 'DemoQueue', {
      queueName: 'StackformDemoQueue',
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ── SSM Parameter ────────────────────────────────────────────────────────
    const configParam = new ssm.StringParameter(this, 'DemoConfig', {
      parameterName: '/stackform-demo/config',
      stringValue: JSON.stringify({
        environment: process.env.ENVIRONMENT ?? 'demo',
        featureFlags: { enableMetrics: true, enableNotifications: true },
        version: '1.0.0',
      }),
      description: 'Stackform Demo app configuration',
    });

    // ── Lambda Shared Props ──────────────────────────────────────────────────
    const commonEnv: Record<string, string> = {
      TABLE_NAME: ddbTable.tableName,
      QUEUE_URL: queue.queueUrl,
      ENVIRONMENT: process.env.ENVIRONMENT ?? 'demo',
      CONFIG_PARAM: configParam.parameterName,
    };

    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: commonEnv,
    } as const;

    // ── Hello Lambda ─────────────────────────────────────────────────────────
    const helloFn = new lambda.Function(this, 'HelloFunction', {
      ...commonLambdaProps,
      functionName: 'stackform-demo-hello',
      description: 'Returns greeting + DynamoDB item count',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/hello')),
      handler: 'index.handler',
    });
    ddbTable.grantReadData(helloFn);

    // ── Process Lambda ───────────────────────────────────────────────────────
    const processFn = new lambda.Function(this, 'ProcessFunction', {
      ...commonLambdaProps,
      functionName: 'stackform-demo-process',
      description: 'Transforms input, writes to DynamoDB, enqueues SQS message',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/process')),
      handler: 'index.handler',
    });
    ddbTable.grantWriteData(processFn);
    queue.grantSendMessages(processFn);

    // ── Notify Lambda ────────────────────────────────────────────────────────
    const notifyFn = new lambda.Function(this, 'NotifyFunction', {
      ...commonLambdaProps,
      functionName: 'stackform-demo-notify',
      description: 'Publishes custom CloudWatch metric for notifications',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/notify')),
      handler: 'index.handler',
    });
    notifyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // ── Step Functions Express Workflow ──────────────────────────────────────
    const helloTask = new tasks.LambdaInvoke(this, 'HelloTask', {
      lambdaFunction: helloFn,
      outputPath: '$.Payload',
      comment: 'Call Hello Lambda',
    });

    const processTask = new tasks.LambdaInvoke(this, 'ProcessTask', {
      lambdaFunction: processFn,
      outputPath: '$.Payload',
      comment: 'Call Process Lambda',
    });

    const notifyTask = new tasks.LambdaInvoke(this, 'NotifyTask', {
      lambdaFunction: notifyFn,
      outputPath: '$.Payload',
      comment: 'Call Notify Lambda',
    });

    const chain = sfn.Chain.start(helloTask)
      .next(processTask)
      .next(notifyTask);

    const stateMachine = new sfn.StateMachine(this, 'DemoStateMachine', {
      stateMachineName: 'StackformDemoWorkflow',
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definitionBody: sfn.DefinitionBody.fromChainable(chain),
      timeout: cdk.Duration.minutes(5),
    });

    // ── Workflow Lambda (starts SFN execution) ───────────────────────────────
    const workflowFn = new lambda.Function(this, 'WorkflowFunction', {
      ...commonLambdaProps,
      functionName: 'stackform-demo-workflow',
      description: 'Starts Step Functions Express execution and returns result',
      code: lambda.Code.fromInline(`
const { SFNClient, StartSyncExecutionCommand } = require('@aws-sdk/client-sfn');
const sfn = new SFNClient({});
exports.handler = async (event) => {
  let input = {};
  try {
    const raw = event.body ?? event;
    input = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {}
  const result = await sfn.send(new StartSyncExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    input: JSON.stringify(input),
  }));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      executionArn: result.executionArn,
      status: result.status,
      output: result.output ? JSON.parse(result.output) : null,
      startDate: result.startDate,
      stopDate: result.stopDate,
    }),
  };
};
      `),
      handler: 'index.handler',
      environment: {
        ...commonEnv,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
      runtime: lambda.Runtime.NODEJS_22_X,
    });
    stateMachine.grantStartSyncExecution(workflowFn);

    // ── HTTP API Gateway (v2) ────────────────────────────────────────────────
    const httpApi = new apigwv2.HttpApi(this, 'DemoHttpApi', {
      apiName: 'StackformDemoApi',
      description: 'Stackform Demo HTTP API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    httpApi.addRoutes({
      path: '/hello',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('HelloIntegration', helloFn),
    });

    httpApi.addRoutes({
      path: '/process',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ProcessIntegration', processFn),
    });

    httpApi.addRoutes({
      path: '/workflow/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('WorkflowIntegration', workflowFn),
    });

    // ── EventBridge Scheduled Rule ───────────────────────────────────────────
    new events.Rule(this, 'HelloSchedule', {
      ruleName: 'stackform-demo-hello-schedule',
      description: 'Trigger HelloFunction every 5 minutes',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(helloFn)],
    });

    // ── CloudWatch Alarms ────────────────────────────────────────────────────
    const lambdaErrorAlarm = (fn: lambda.Function, name: string) =>
      new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `stackform-demo-${name.toLowerCase()}-errors`,
        alarmDescription: `Lambda error rate alarm for ${name}`,
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    lambdaErrorAlarm(helloFn, 'Hello');
    lambdaErrorAlarm(processFn, 'Process');
    lambdaErrorAlarm(notifyFn, 'Notify');

    new cloudwatch.Alarm(this, 'Api4xxAlarm', {
      alarmName: 'stackform-demo-api-4xx-errors',
      alarmDescription: 'API Gateway 4XX error rate alarm',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4xx',
        dimensionsMap: { ApiId: httpApi.apiId },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── Next.js Static Site (S3 + CloudFront) ────────────────────────────────
    // Build the Next.js app (output: "export") during CDK synthesis
    const webDir = path.join(__dirname, '../web');
    console.log('Building Next.js static site...');
    // Use the workspace-installed next binary from root node_modules
    const nextBin = path.join(__dirname, '../node_modules/.bin/next');
    execSync(`${nextBin} build`, {
      cwd: webDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });

    // S3 bucket to host the static files
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution with OAC
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
    });

    // Deploy static files + a runtime config.json containing the live API URL
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset(path.join(webDir, 'out')),
        // config.json resolves CloudFormation tokens at deploy time
        s3deploy.Source.jsonData('config.json', {
          apiUrl: httpApi.apiEndpoint,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ── CloudFormation Outputs ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      exportName: 'StackformDemoApiUrl',
      value: httpApi.apiEndpoint,
      description: 'HTTP API endpoint URL',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      exportName: 'StackformDemoCloudFrontUrl',
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the Next.js website',
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      exportName: 'StackformDemoStateMachineArn',
      value: stateMachine.stateMachineArn,
      description: 'Step Functions Express state machine ARN',
    });

    new cdk.CfnOutput(this, 'DynamoTableName', {
      exportName: 'StackformDemoDynamoTable',
      value: ddbTable.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'SqsQueueUrl', {
      exportName: 'StackformDemoSqsQueueUrl',
      value: queue.queueUrl,
      description: 'SQS queue URL',
    });
  }
}
