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
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Notes' })).toBeAttached();
});

test('API round trip', async ({ request }) => {
  const tag = `smoke-${expectedVersion.slice(0, 7)}`;
  const created = await request.post('/api/notes', { data: { text: 'smoke test note', tag } });
  expect(created.status()).toBe(201);
  const { note } = await created.json();
  try {
    // list is capped (MAX_LIST), so membership is not guaranteed; the 204 below proves the note exists.
    const listed = await request.get('/api/notes');
    expect(listed.status()).toBe(200);
    expect(Array.isArray((await listed.json()).notes)).toBe(true);
  } finally {
    expect((await request.delete(`/api/notes/${note.id}`)).status()).toBe(204);
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
