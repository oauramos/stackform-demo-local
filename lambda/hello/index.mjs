import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});

export const handler = async (event) => {
  // Handle both EventBridge scheduled events and HTTP API events
  const isScheduled = event?.source === 'aws.events';

  let itemCount = 0;
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: process.env.TABLE_NAME,
      Select: 'COUNT',
    }));
    itemCount = result.Count ?? 0;
  } catch (err) {
    console.error('DynamoDB scan error:', err);
  }

  const body = {
    message: 'Hello from Stackform Demo!',
    timestamp: new Date().toISOString(),
    itemCount,
    invocationSource: isScheduled ? 'EventBridge Schedule' : 'HTTP API',
  };

  if (isScheduled) {
    console.log('Scheduled invocation:', JSON.stringify(body));
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
