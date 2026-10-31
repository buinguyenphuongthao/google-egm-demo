import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createServer } from 'node:http';
import { createHandler } from './handler';
import { createDynamoRepo } from './repo';

const port = Number(process.env.PORT ?? 3001);
const tableName = process.env.TABLE_NAME ?? 'notes-local';
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

try {
  await new DynamoDBClient({ endpoint }).send(
    new CreateTableCommand({
      TableName: tableName,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
}

const handler = createHandler({
  repo: createDynamoRepo(tableName, endpoint),
  version: process.env.VERSION ?? 'dev',
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const event = {
    rawPath: url.pathname,
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method ?? 'GET' } },
  } as unknown as APIGatewayProxyEventV2;
  const result = await handler(event);
  res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string> | undefined);
  res.end(result.body ?? '');
}).listen(port, () => console.log(`api listening on http://localhost:${port}`));
