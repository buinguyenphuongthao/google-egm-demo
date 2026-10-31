import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BoardItem, Column, Project } from './board';

/**
 * Storage only: no expiry filtering or rules (those live in board-routes.ts). Projects
 * sit in one PROJECTS partition; a project's columns, cards and labels share its partition.
 */
export interface BoardRepo {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  /** Writes the project and its default columns together. */
  createProject(project: Project, columns: Column[]): Promise<void>;
  /** Returns false when the project item no longer exists. */
  updateProject(project: Project): Promise<boolean>;
  /** Deletes the project item only; delete its items first. */
  deleteProject(id: string): Promise<void>;
  /** Every column, card and label in the project, expired or not. */
  listItems(projectId: string): Promise<BoardItem[]>;
  createItem(item: BoardItem): Promise<void>;
  /** Returns false when the item no longer exists, so a concurrent delete is not undone. */
  updateItem(item: BoardItem): Promise<boolean>;
  deleteItems(items: BoardItem[]): Promise<void>;
}

const PROJECTS = 'PROJECTS';
const SK_PREFIX = { column: 'COLUMN#', card: 'CARD#', label: 'LABEL#' } as const;
const projectPk = (id: string) => `PROJECT#${id}`;
const itemKey = (item: Pick<BoardItem, 'kind' | 'projectId' | 'id'>) => ({
  pk: projectPk(item.projectId),
  sk: SK_PREFIX[item.kind] + item.id,
});
const exists = 'attribute_exists(pk)';
const absent = 'attribute_not_exists(pk)';

// BatchWriteItem accepts at most 25 requests per call.
const BATCH = 25;
const MAX_ATTEMPTS = 5;

type Stored = Record<string, unknown> & { pk: string; sk: string };

function withoutKeys(stored: Stored): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...stored };
  delete copy.pk;
  delete copy.sk;
  return copy;
}

function toProject(stored: Stored): Project {
  return withoutKeys(stored) as unknown as Project;
}

function toItem(stored: Stored): BoardItem | undefined {
  for (const [kind, prefix] of Object.entries(SK_PREFIX)) {
    if (stored.sk.startsWith(prefix)) return { kind, ...withoutKeys(stored) } as unknown as BoardItem;
  }
  return undefined;
}

function toStored(item: BoardItem): Stored {
  const { kind, ...rest } = item;
  return { pk: projectPk(rest.projectId), sk: SK_PREFIX[kind] + rest.id, ...rest };
}

export function createDynamoBoardRepo(tableName: string, endpoint?: string): BoardRepo {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  async function queryAll(pk: string): Promise<Stored[]> {
    const items: Stored[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': pk },
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((page.Items ?? []) as Stored[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async function put(item: Stored, condition: string): Promise<boolean> {
    try {
      await doc.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: condition }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    async listProjects() {
      return (await queryAll(PROJECTS)).map(toProject);
    },
    async getProject(id) {
      const { Item } = await doc.send(new GetCommand({ TableName: tableName, Key: { pk: PROJECTS, sk: id } }));
      return Item ? toProject(Item as Stored) : undefined;
    },
    async createProject(project, columns) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: tableName, Item: { pk: PROJECTS, sk: project.id, ...project }, ConditionExpression: absent } },
              ...columns.map((c) => ({
                Put: { TableName: tableName, Item: toStored({ kind: 'column', ...c }), ConditionExpression: absent },
              })),
            ],
          }),
        );
      } catch (err) {
        // Only a server-generated id collision can fail the condition.
        if (err instanceof TransactionCanceledException) throw new Error('project id collision', { cause: err });
        throw err;
      }
    },
    async updateProject(project) {
      return put({ pk: PROJECTS, sk: project.id, ...project }, exists);
    },
    async deleteProject(id) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk: PROJECTS, sk: id } }));
    },
    async listItems(projectId) {
      return (await queryAll(projectPk(projectId))).flatMap((s) => toItem(s) ?? []);
    },
    async createItem(item) {
      if (!(await put(toStored(item), absent))) throw new Error(`${item.kind} id collision`);
    },
    async updateItem(item) {
      return put(toStored(item), exists);
    },
    async deleteItems(items) {
      for (let i = 0; i < items.length; i += BATCH) {
        let requests = items.slice(i, i + BATCH).map((item) => ({ DeleteRequest: { Key: itemKey(item) } }));
        for (let attempt = 1; requests.length > 0; attempt++) {
          if (attempt > MAX_ATTEMPTS) throw new Error('batch delete did not finish; retry the request');
          const { UnprocessedItems } = await doc.send(
            new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
          );
          requests = (UnprocessedItems?.[tableName] ?? []) as typeof requests;
          if (requests.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        }
      }
    },
  };
}
