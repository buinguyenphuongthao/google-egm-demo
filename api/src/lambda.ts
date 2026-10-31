import { createHandler } from './handler';
import { createDynamoRepo } from './repo';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is required');

export const handler = createHandler({
  repo: createDynamoRepo(tableName),
  version: process.env.VERSION ?? 'dev',
});
