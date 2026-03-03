import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

export const handler = async (event) => {
  let input = {};
  try {
    const rawBody = event.body ?? event;
    input = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    input = { raw: String(event.body ?? '') };
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();

  // Write record to DynamoDB
  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: {
      id: { S: id },
      input: { S: JSON.stringify(input) },
      createdAt: { S: createdAt },
    },
  }));

  // Enqueue SQS message
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.QUEUE_URL,
    MessageBody: JSON.stringify({ id, input, createdAt }),
    MessageAttributes: {
      Source: { DataType: 'String', StringValue: 'ProcessFunction' },
    },
  }));

  const body = {
    id,
    input,
    processed: true,
    createdAt,
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
};
