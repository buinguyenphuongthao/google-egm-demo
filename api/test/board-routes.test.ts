import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, DONE_TTL_SECONDS, type BoardItem } from '../src/board';
import { createHandler } from '../src/handler';
import { memoryBoardRepo } from './memory-board-repo';

const START = new Date('2026-11-01T00:00:00Z');
const EPOCH = START.getTime() / 1000;
const MISSING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function event(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

let repo: ReturnType<typeof memoryBoardRepo>;
let clock: Date;
// Loose view of response bodies; each test asserts the fields it needs.
type Item = { id: string; name: string; [field: string]: unknown };
type Body = Record<'project' | 'column' | 'card' | 'label', Item> &
  Record<'projects' | 'columns' | 'cards' | 'labels', Item[]>;
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Body }>;

beforeEach(() => {
  repo = memoryBoardRepo();
  clock = START;
  let n = 0;
  const handler = createHandler({
    boardRepo: repo,
    version: 'v1',
    now: () => clock,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  call = async (method, path, body) => {
    const res = await handler(event(method, path, body));
    return { status: res.statusCode ?? 0, body: res.body ? JSON.parse(res.body) : undefined };
  };
});

async function newProject(name = 'Work') {
  const { body } = await call('POST', '/api/projects', { name });
  const board = await call('GET', `/api/projects/${body.project.id}/board`);
  const [todo, doing, done] = board.body.columns as [Item, Item, Item];
  return { id: body.project.id as string, todo, doing, done, base: `/api/projects/${body.project.id}` };
}

describe('projects', () => {
  it('creates a project with To do, Doing and Done, Done being the done column', async () => {
    const { todo, doing, done } = await newProject();
    expect([todo.name, doing.name, done.name]).toEqual(['To do', 'Doing', 'Done']);
    expect([todo.isDone, doing.isDone, done.isDone]).toEqual([false, false, true]);
  });

  it('lists projects oldest first and renames them', async () => {
    const a = await newProject('A');
    clock = new Date(START.getTime() + 1000);
    await newProject('B');
    expect((await call('PATCH', a.base, { name: 'A2' })).body.project.name).toBe('A2');
    expect((await call('GET', '/api/projects')).body.projects.map((p) => p.name)).toEqual(['A2', 'B']);
  });

  it('caps projects at 50, not counting smoke projects', async () => {
    for (let i = 0; i < CAPS.projects; i++) await call('POST', '/api/projects', { name: `p${i}` });
    expect((await call('POST', '/api/projects', { name: 'one more' })).status).toBe(409);
    expect((await call('POST', '/api/projects', { name: 'smoke-abc' })).status).toBe(201);
  });

  it('keeps smoke status when a project is renamed', async () => {
    const smoke = await newProject('smoke-abc');
    const renamed = await call('PATCH', smoke.base, { name: 'real work' });
    expect(renamed.body.project).toMatchObject({ isSmoke: true, expiresAt: EPOCH + 3600 });
    const real = await newProject('Work');
    expect((await call('PATCH', real.base, { name: 'smoke-x' })).body.project.isSmoke).toBe(false);
  });

  it('gives every item in a smoke project the project expiry', async () => {
    const smoke = await newProject('smoke-abc');
    const label = await call('POST', `${smoke.base}/labels`, { name: 'l', color: 'red' });
    const card = await call('POST', `${smoke.base}/cards`, { columnId: smoke.done.id, rank: 'a0', title: 't' });
    for (const item of [smoke.todo, smoke.done, label.body.label, card.body.card]) {
      expect(item.expiresAt).toBe(EPOCH + 3600);
    }
    expect(card.body.card.doneAt).toBeUndefined();
  });

  it('hides expired projects and their boards', async () => {
    const smoke = await newProject('smoke-abc');
    clock = new Date(START.getTime() + 3600_000);
    expect((await call('GET', '/api/projects')).body.projects).toEqual([]);
    expect((await call('GET', `${smoke.base}/board`)).status).toBe(404);
  });

  it('deletes a project with everything in it, and can finish a partial delete', async () => {
    const p = await newProject();
    await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't' });
    // A delete that failed after removing some children leaves the project visible.
    await repo.deleteItems([{ kind: 'column', ...p.doing } as unknown as BoardItem]);
    expect((await call('GET', `${p.base}/board`)).status).toBe(200);
    expect((await call('DELETE', p.base)).status).toBe(204);
    expect(repo.items.size).toBe(0);
    expect(repo.projects.size).toBe(0);
    expect((await call('DELETE', p.base)).status).toBe(404);
  });

  it('404s on a missing project', async () => {
    expect((await call('GET', `/api/projects/${MISSING}/board`)).status).toBe(404);
    expect((await call('PATCH', `/api/projects/${MISSING}`, { name: 'x' })).status).toBe(404);
    expect((await call('POST', `/api/projects/${MISSING}/cards`, { columnId: MISSING, rank: 'a0', title: 't' })).status).toBe(404);
  });
});

describe('columns', () => {
  it('adds, renames, reorders, and lists columns by rank', async () => {
    const p = await newProject();
    const added = await call('POST', `${p.base}/columns`, { name: 'Review', rank: 'a1V' });
    expect(added.status).toBe(201);
    expect(added.body.column.isDone).toBe(false);
    await call('PATCH', `${p.base}/columns/${p.todo.id}`, { name: 'Backlog', rank: 'a3' });
    const names = (await call('GET', `${p.base}/board`)).body.columns.map((c) => c.name);
    expect(names).toEqual(['Doing', 'Review', 'Done', 'Backlog']);
  });

  it('refuses to delete the done column or a column with cards', async () => {
    const p = await newProject();
    expect((await call('DELETE', `${p.base}/columns/${p.done.id}`)).status).toBe(409);
    await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't' });
    expect((await call('DELETE', `${p.base}/columns/${p.todo.id}`)).status).toBe(409);
    expect((await call('DELETE', `${p.base}/columns/${p.doing.id}`)).status).toBe(204);
    expect((await call('DELETE', `${p.base}/columns/${p.doing.id}`)).status).toBe(404);
  });

  it('caps columns at 20 per project', async () => {
    const p = await newProject();
    for (let i = 3; i < CAPS.columns; i++) await call('POST', `${p.base}/columns`, { name: `c${i}`, rank: `b${i}` });
    expect((await call('POST', `${p.base}/columns`, { name: 'x', rank: 'z0' })).status).toBe(409);
  });
});

describe('cards', () => {
  it('creates a card and moves it between columns', async () => {
    const p = await newProject();
    const created = await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: ' Write tests ' });
    expect(created.status).toBe(201);
    expect(created.body.card).toMatchObject({ title: 'Write tests', description: '', labelIds: [] });
    const moved = await call('PATCH', `${p.base}/cards/${created.body.card.id}`, { columnId: p.doing.id, rank: 'a0' });
    expect(moved.body.card.columnId).toBe(p.doing.id);
    expect(moved.body.card.expiresAt).toBeUndefined();
  });

  it('expires a card 7 days after it enters the done column, and clears that when it leaves', async () => {
    const p = await newProject();
    const card = (await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't' })).body.card;
    const url = `${p.base}/cards/${card.id}`;
    const inDone = (await call('PATCH', url, { columnId: p.done.id })).body.card;
    expect(inDone).toMatchObject({ doneAt: START.toISOString(), expiresAt: EPOCH + DONE_TTL_SECONDS });

    clock = new Date(START.getTime() + 1000);
    const renamed = (await call('PATCH', url, { title: 'renamed' })).body.card;
    expect(renamed.expiresAt).toBe(EPOCH + DONE_TTL_SECONDS);

    const back = (await call('PATCH', url, { columnId: p.todo.id })).body.card;
    expect(back.doneAt).toBeUndefined();
    expect(back.expiresAt).toBeUndefined();
  });

  it('treats an expired card as gone', async () => {
    const p = await newProject();
    const card = (await call('POST', `${p.base}/cards`, { columnId: p.done.id, rank: 'a0', title: 't' })).body.card;
    clock = new Date((EPOCH + DONE_TTL_SECONDS) * 1000);
    expect((await call('GET', `${p.base}/board`)).body.cards).toEqual([]);
    expect((await call('PATCH', `${p.base}/cards/${card.id}`, { columnId: p.todo.id })).status).toBe(404);
    expect((await call('DELETE', `${p.base}/cards/${card.id}`)).status).toBe(404);
  });

  it('rejects columns and labels from another project', async () => {
    const p = await newProject('A');
    const q = await newProject('B');
    const label = (await call('POST', `${q.base}/labels`, { name: 'l', color: 'red' })).body.label;
    expect((await call('POST', `${p.base}/cards`, { columnId: q.todo.id, rank: 'a0', title: 't' })).status).toBe(400);
    expect(
      (await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't', labelIds: [label.id] })).status,
    ).toBe(400);
    const card = (await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't' })).body.card;
    expect((await call('PATCH', `${q.base}/cards/${card.id}`, { title: 'x' })).status).toBe(404);
  });

  it('caps cards at 1000 per project', async () => {
    const p = await newProject();
    for (let i = 0; i < CAPS.cards; i++) {
      await repo.createItem({
        kind: 'card',
        id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        projectId: p.id,
        columnId: p.todo.id,
        rank: 'a0',
        title: 't',
        description: '',
        labelIds: [],
      });
    }
    expect((await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a1', title: 't' })).status).toBe(409);
  });

  it('enforces the 16 KB body limit on board routes', async () => {
    const p = await newProject();
    expect((await call('POST', `${p.base}/cards`, 'x'.repeat(16 * 1024 + 1))).status).toBe(413);
    expect((await call('POST', `${p.base}/cards`, '{nope')).status).toBe(400);
  });
});

describe('labels', () => {
  it('drops a deleted label from cards on read and on the next write', async () => {
    const p = await newProject();
    const bug = (await call('POST', `${p.base}/labels`, { name: 'bug', color: 'red' })).body.label;
    const ui = (await call('POST', `${p.base}/labels`, { name: 'ui', color: 'blue' })).body.label;
    const card = (
      await call('POST', `${p.base}/cards`, { columnId: p.todo.id, rank: 'a0', title: 't', labelIds: [bug.id, ui.id] })
    ).body.card;

    expect((await call('DELETE', `${p.base}/labels/${bug.id}`)).status).toBe(204);
    const board = (await call('GET', `${p.base}/board`)).body;
    expect(board.labels.map((l) => l.name)).toEqual(['ui']);
    expect(board.cards[0]!.labelIds).toEqual([ui.id]);

    const updated = (await call('PATCH', `${p.base}/cards/${card.id}`, { title: 'x' })).body.card;
    expect(updated.labelIds).toEqual([ui.id]);
  });

  it('renames and recolors a label, and caps labels at 30', async () => {
    const p = await newProject();
    const label = (await call('POST', `${p.base}/labels`, { name: 'bug', color: 'red' })).body.label;
    const updated = await call('PATCH', `${p.base}/labels/${label.id}`, { name: 'defect', color: 'orange' });
    expect(updated.body.label).toMatchObject({ name: 'defect', color: 'orange' });
    for (let i = 1; i < CAPS.labels; i++) await call('POST', `${p.base}/labels`, { name: `l${i}`, color: 'gray' });
    expect((await call('POST', `${p.base}/labels`, { name: 'x', color: 'gray' })).status).toBe(409);
  });
});
