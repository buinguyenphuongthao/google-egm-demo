import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createServer } from 'node:http';
import { createDynamoBoardRepo } from './board-repo';
import { createHandler } from './handler';
import { createDynamoRepo } from './repo';

const port = Number(process.env.PORT ?? 3001);
const tableName = process.env.TABLE_NAME ?? 'notes-local';
const boardTableName = process.env.BOARD_TABLE_NAME ?? 'board-local';
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function ensureTable(name: string, keys: string[]) {
  try {
    await new DynamoDBClient({ endpoint }).send(
      new CreateTableCommand({
        TableName: name,
        KeySchema: keys.map((k, i) => ({ AttributeName: k, KeyType: i === 0 ? 'HASH' : 'RANGE' })),
        AttributeDefinitions: keys.map((k) => ({ AttributeName: k, AttributeType: 'S' })),
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
}

await ensureTable(tableName, ['id']);
await ensureTable(boardTableName, ['pk', 'sk']);

const handler = createHandler({
  repo: createDynamoRepo(tableName, endpoint),
  boardRepo: createDynamoBoardRepo(boardTableName, endpoint),
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
