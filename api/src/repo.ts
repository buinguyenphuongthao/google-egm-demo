import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Note } from './notes';

export interface NotesRepo {
  list(): Promise<Note[]>;
  create(note: Note): Promise<void>;
  /** Returns false when no note has this id. */
  delete(id: string): Promise<boolean>;
  ping(): Promise<boolean>;
}

/** Upper bound on notes returned by list(), so one request cannot scan an unbounded table. */
export const MAX_LIST = 1000;

export function createDynamoRepo(tableName: string, endpoint?: string): NotesRepo {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}));
  return {
    async list() {
      // Demo scale: scan, but stop after MAX_LIST items. Notes expire after a week, and API
      // Gateway throttling bounds the request rate. Past the cap the result is a sorted
      // subset, not necessarily the newest MAX_LIST notes.
      const notes: Note[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey, Limit: MAX_LIST - notes.length }),
        );
        notes.push(...((page.Items ?? []) as Note[]));
        startKey = page.LastEvaluatedKey;
      } while (startKey && notes.length < MAX_LIST);
      return notes
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_LIST);
    },
    async create(note) {
      await doc.send(
        new PutCommand({ TableName: tableName, Item: note, ConditionExpression: 'attribute_not_exists(id)' }),
      );
    },
    async delete(id) {
      try {
        await doc.send(
          new DeleteCommand({ TableName: tableName, Key: { id }, ConditionExpression: 'attribute_exists(id)' }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
    async ping() {
      try {
        await doc.send(new GetCommand({ TableName: tableName, Key: { id: '__health__' } }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
