import { createDynamoBoardRepo } from './board-repo';
import { createHandler } from './handler';

const boardTableName = process.env.BOARD_TABLE_NAME;
if (!boardTableName) throw new Error('BOARD_TABLE_NAME is required');
const originVerify = process.env.ORIGIN_VERIFY;
if (!originVerify) throw new Error('ORIGIN_VERIFY is required');

export const handler = createHandler({
  boardRepo: createDynamoBoardRepo(boardTableName),
  version: process.env.VERSION ?? 'dev',
  originVerify,
});
