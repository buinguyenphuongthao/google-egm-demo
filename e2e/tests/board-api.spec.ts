import { expect, test } from '@playwright/test';

// The board API against DynamoDB Local, through the same /api proxy the SPA uses. Covers
// the real DynamoDB repo (keys, conditional writes, query paging, batch delete), which the
// unit tests replace with an in-memory fake.
test('board API round trip: project, columns, cards, labels, delete', async ({ request }) => {
  const created = await request.post('/api/projects', { data: { name: `e2e ${Date.now()}` } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const base = `/api/projects/${project.id}`;

  const board = await (await request.get(`${base}/board`)).json();
  expect(board.columns.map((c: { name: string }) => c.name)).toEqual(['To do', 'Doing', 'Done']);
  const [todo, doing, done] = board.columns;

  const label = (await (await request.post(`${base}/labels`, { data: { name: 'bug', color: 'red' } })).json()).label;
  const card = (
    await (
      await request.post(`${base}/cards`, {
        data: { columnId: todo.id, rank: 'a0', title: '<b>literal</b>', labelIds: [label.id] },
      })
    ).json()
  ).card;

  const moved = await request.patch(`${base}/cards/${card.id}`, { data: { columnId: done.id, rank: 'a0' } });
  expect(moved.status()).toBe(200);
  expect((await moved.json()).card.expiresAt).toEqual(expect.any(Number));

  expect((await request.delete(`${base}/columns/${done.id}`)).status()).toBe(409);
  expect((await request.delete(`${base}/columns/${doing.id}`)).status()).toBe(204);
  expect((await request.delete(`${base}/labels/${label.id}`)).status()).toBe(204);

  const after = await (await request.get(`${base}/board`)).json();
  expect(after.columns).toHaveLength(2);
  expect(after.labels).toEqual([]);
  expect(after.cards).toEqual([
    expect.objectContaining({ id: card.id, title: '<b>literal</b>', columnId: done.id, labelIds: [] }),
  ]);

  expect((await request.delete(base)).status()).toBe(204);
  expect((await request.get(`${base}/board`)).status()).toBe(404);
  const { projects } = await (await request.get('/api/projects')).json();
  expect(projects.map((p: { id: string }) => p.id)).not.toContain(project.id);
});

test('board API rejects unknown fields and other projects\' ids', async ({ request }) => {
  const a = (await (await request.post('/api/projects', { data: { name: `e2e a ${Date.now()}` } })).json()).project;
  const b = (await (await request.post('/api/projects', { data: { name: `e2e b ${Date.now()}` } })).json()).project;
  try {
    const bColumns = (await (await request.get(`/api/projects/${b.id}/board`)).json()).columns;
    const res = await request.post(`/api/projects/${a.id}/cards`, {
      data: { columnId: bColumns[0].id, rank: 'a0', title: 't' },
    });
    expect(res.status()).toBe(400);
    const forged = await request.patch(`/api/projects/${a.id}`, { data: { name: 'x', isSmoke: true } });
    expect(forged.status()).toBe(400);
  } finally {
    await request.delete(`/api/projects/${a.id}`);
    await request.delete(`/api/projects/${b.id}`);
  }
});
