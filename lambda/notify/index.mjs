import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({});

export const handler = async (event) => {
  let input = {};
  try {
    const rawBody = event.body ?? event;
    input = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    input = {};
  }

  // Publish custom metric
  await cw.send(new PutMetricDataCommand({
    Namespace: 'StackformDemo/Notifications',
    MetricData: [
      {
        MetricName: 'NotificationsSent',
        Value: 1,
        Unit: 'Count',
        Dimensions: [
          { Name: 'Environment', Value: process.env.ENVIRONMENT ?? 'demo' },
        ],
      },
    ],
  }));

  const body = {
    notified: true,
    metricPublished: true,
    timestamp: new Date().toISOString(),
    input,
  };

  // Handle Step Functions invocation (no HTTP wrapper needed)
  if (!event.httpMethod && !event.requestContext) {
    return body;
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
};
