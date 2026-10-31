import { createHandler } from './handler';
import { createDynamoRepo } from './repo';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is required');
const originVerify = process.env.ORIGIN_VERIFY;
if (!originVerify) throw new Error('ORIGIN_VERIFY is required');

export const handler = createHandler({
  repo: createDynamoRepo(tableName),
  version: process.env.VERSION ?? 'dev',
  originVerify,
});
