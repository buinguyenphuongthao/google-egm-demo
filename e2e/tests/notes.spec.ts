import { expect, test } from '@playwright/test';

test('creates, persists, and deletes a note', async ({ page }) => {
  const text = `e2e note ${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();

  await page.getByLabel('New note').fill(text);
  await page.getByRole('button', { name: 'Add note' }).click();
  const list = page.getByRole('list', { name: 'Notes' });
  await expect(list.getByText(text)).toBeVisible();

  await page.reload();
  await expect(list.getByText(text)).toBeVisible();

  await page.getByRole('button', { name: `Delete note: ${text}` }).click();
  await expect(list.getByText(text)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(list.getByText(text)).toHaveCount(0);
});

test('disables Add for blank notes', async ({ page }) => {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add note' });
  await expect(add).toBeDisabled();
  await page.getByLabel('New note').fill('   ');
  await expect(add).toBeDisabled();
});

test('renders note text literally, never as HTML', async ({ page }) => {
  const payload = `<img src=x onerror="window.__xss=1"> ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('New note').fill(payload);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByRole('list', { name: 'Notes' }).getByText(payload)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});
