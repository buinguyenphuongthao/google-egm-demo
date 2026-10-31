import { createDynamoBoardRepo } from './board-repo';
import { createHandler } from './handler';
import { createDynamoRepo } from './repo';

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error('TABLE_NAME is required');
const boardTableName = process.env.BOARD_TABLE_NAME;
if (!boardTableName) throw new Error('BOARD_TABLE_NAME is required');
const originVerify = process.env.ORIGIN_VERIFY;
if (!originVerify) throw new Error('ORIGIN_VERIFY is required');

export const handler = createHandler({
  repo: createDynamoRepo(tableName),
  boardRepo: createDynamoBoardRepo(boardTableName),
  version: process.env.VERSION ?? 'dev',
  originVerify,
});
