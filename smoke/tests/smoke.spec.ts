import { expect, test } from '@playwright/test';

const expectedVersion = process.env.EXPECTED_VERSION ?? 'dev';

test.describe.configure({ mode: 'serial' });

test('health reports the deployed version and a healthy db', async ({ request }) => {
  // CloudFront may briefly serve the previous Lambda version right after a deploy.
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/health');
        return res.ok() ? (await res.json()).version : `HTTP ${res.status()}`;
      },
      { timeout: 120_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toBe(expectedVersion);

  const health = await (await request.get('/api/health')).json();
  expect(health).toMatchObject({ status: 'ok', dbOk: true });
});

test('SPA loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible();
});

test('board API round trip', async ({ request }) => {
  // A smoke- project: all its items expire after 1 hour and it does not count toward the cap.
  const created = await request.post('/api/projects', { data: { name: `smoke-${expectedVersion.slice(0, 7)}` } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const base = `/api/projects/${project.id}`;
  try {
    const { columns } = await (await request.get(`${base}/board`)).json();
    const [todo, doing] = columns;
    const added = await request.post(`${base}/cards`, { data: { columnId: todo.id, rank: 'a0', title: 'smoke card' } });
    expect(added.status()).toBe(201);
    const { card } = await added.json();

    const moved = await request.patch(`${base}/cards/${card.id}`, { data: { columnId: doing.id, rank: 'a0' } });
    expect(moved.status()).toBe(200);
    const board = await (await request.get(`${base}/board`)).json();
    expect(board.cards).toEqual([expect.objectContaining({ id: card.id, columnId: doing.id })]);
  } finally {
    expect((await request.delete(base)).status()).toBe(204);
  }
});

// Proves the lock is on. Runs only in CI: from the owner's allowlisted IP it would fail.
test('the site is closed to anonymous visitors', async ({ playwright, baseURL }) => {
  test.skip(!process.env.CI, 'needs a non-allowlisted IP (CI runner)');
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: {} });
  try {
    expect((await anon.get('/')).status()).toBe(403);
    expect((await anon.get('/api/health')).status()).toBe(403);
  } finally {
    await anon.dispose();
  }
});
