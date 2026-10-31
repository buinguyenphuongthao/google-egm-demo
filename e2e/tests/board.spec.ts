import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

interface Project {
  id: string;
  name: string;
}
interface Column {
  id: string;
  name: string;
  isDone: boolean;
}

const unique = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function newProject(request: APIRequestContext, name = unique('e2e')): Promise<Project> {
  const res = await request.post('/api/projects', { data: { name } });
  expect(res.status()).toBe(201);
  return (await res.json()).project;
}

async function columnsOf(request: APIRequestContext, project: Project): Promise<Column[]> {
  return (await (await request.get(`/api/projects/${project.id}/board`)).json()).columns;
}

// Each test gets its own project, deleted afterwards so local runs stay under the project cap.
const test = base.extend<{ project: Project }>({
  project: async ({ request }, use) => {
    const project = await newProject(request);
    await use(project);
    await request.delete(`/api/projects/${project.id}`);
  },
});

const open = (page: Page, project: Project) => page.goto(`/#${project.id}`);
const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const cardsIn = (page: Page, name: string) => page.getByRole('list', { name: `${name} cards`, exact: true });
const card = (page: Page, title: string) => page.getByRole('button', { name: title, exact: true });

async function addCards(page: Page, columnName: string, titles: string[]) {
  await column(page, columnName).getByRole('button', { name: 'Add card' }).click();
  const input = page.getByLabel(`New card in ${columnName}`);
  for (const title of titles) {
    await input.fill(title);
    await input.press('Enter');
    await expect(cardsIn(page, columnName).getByText(title, { exact: true })).toBeVisible();
  }
  await input.press('Escape');
}

const center = async (l: Locator) => {
  const box = (await l.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * Grabs `handle` with the mouse and drags until the center of `moving` (the item the handle
 * belongs to) is over the center of `target`. Small steps cross dnd-kit's 5px activation distance.
 */
async function drag(page: Page, handle: Locator, target: Locator, moving = handle) {
  const grab = await center(handle);
  const item = await center(moving);
  const goal = await center(target);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 10, grab.y + 10, { steps: 5 });
  await page.mouse.move(goal.x + grab.x - item.x, goal.y + grab.y - item.y, { steps: 20 });
  await page.mouse.up();
}

/**
 * Picks up `handle` with Space, presses each arrow key, then drops, waiting for dnd-kit's
 * screen reader announcement after each key. Right after pickup dnd-kit is still adding
 * its key listener and measuring drop targets, so an arrow key can be ignored; it is
 * pressed again only while the announcement shows no move.
 */
async function keyboardMove(page: Page, handle: Locator, moves: { key: string; over: string }[]) {
  const announcer = page.locator('[aria-live="assertive"]');
  await handle.focus();
  await page.keyboard.press('Space');
  for (const { key, over } of moves) {
    const target = new RegExp(` is over ${over}\\.$`);
    await expect(async () => {
      if (!target.test((await announcer.textContent()) ?? '')) await page.keyboard.press(key);
      await expect(announcer).toHaveText(target, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
  }
  await page.keyboard.press('Space');
  await expect(announcer).toHaveText(/^Dropped/);
}

test('creates, renames, and deletes a project', async ({ page, request }) => {
  const name = unique('e2e created');
  const renamed = unique('e2e renamed');
  await page.goto('/');
  try {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('New project name').fill(name);
    await page.getByLabel('New project name').press('Enter');
    const projects = page.getByRole('navigation', { name: 'Projects' });
    await expect(projects.getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.locator('main section h2')).toHaveText(['To do', 'Doing', 'Done']);

    await page.getByRole('heading', { level: 1 }).getByRole('button').click();
    await page.getByLabel('Project name').fill(renamed);
    await page.getByLabel('Project name').press('Enter');
    await expect(projects.getByRole('button', { name: renamed })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);

    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete project' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete project' }).click();
    await expect(projects.getByRole('button', { name: renamed })).toHaveCount(0);
    await page.reload();
    await expect(projects.getByRole('button', { name: renamed })).toHaveCount(0);
  } finally {
    const { projects } = await (await request.get('/api/projects')).json();
    for (const p of projects as Project[]) {
      if (p.name === name || p.name === renamed) await request.delete(`/api/projects/${p.id}`);
    }
  }
});

test('adds, renames, and deletes columns; the done column cannot be deleted', async ({ page, project }) => {
  await open(page, project);
  await page.getByRole('button', { name: 'Add column' }).click();
  await page.getByLabel('New column name').fill('Review');
  await page.getByLabel('New column name').press('Enter');
  await expect(page.locator('main section h2')).toHaveText(['To do', 'Doing', 'Done', 'Review']);

  await page.getByRole('button', { name: 'Column actions: Review' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Column name').fill('QA');
  await page.getByLabel('Column name').press('Enter');
  await expect(column(page, 'QA')).toBeVisible();

  await page.getByRole('button', { name: 'Column actions: Done' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(column(page, 'Done').getByRole('img', { name: 'Done column' })).toBeVisible();

  await page.getByRole('button', { name: 'Column actions: QA' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete column' }).click();
  await expect(column(page, 'QA')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('main section h2')).toHaveText(['To do', 'Doing', 'Done']);
});

test('adds, renames, and deletes cards', async ({ page, project }) => {
  await open(page, project);
  await addCards(page, 'To do', ['First', 'Second']);
  await expect(cardsIn(page, 'To do').getByRole('listitem')).toHaveText(['First', 'Second']);

  await page.getByRole('button', { name: 'Card actions: First' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Card title').fill('First, renamed');
  await page.getByLabel('Card title').press('Enter');
  await expect(card(page, 'First, renamed')).toBeVisible();

  await page.getByRole('button', { name: 'Card actions: Second' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete card' }).click();
  await expect(card(page, 'Second')).toHaveCount(0);

  await page.reload();
  await expect(cardsIn(page, 'To do').getByRole('listitem')).toHaveText(['First, renamed']);
});

test('drags a card between columns with the mouse', async ({ page, project }) => {
  await open(page, project);
  await addCards(page, 'To do', ['Move me', 'Stay']);
  await drag(page, card(page, 'Move me'), column(page, 'Doing'));
  await expect(cardsIn(page, 'Doing').getByText('Move me')).toBeVisible();
  await expect(cardsIn(page, 'To do').getByRole('listitem')).toHaveText(['Stay']);
  await page.reload();
  await expect(cardsIn(page, 'Doing').getByText('Move me')).toBeVisible();
});

test('moves a card with the keyboard', async ({ page, project }) => {
  await open(page, project);
  await addCards(page, 'To do', ['Keyboard card']);
  await keyboardMove(page, card(page, 'Keyboard card'), [{ key: 'ArrowRight', over: 'Doing' }]);
  await expect(cardsIn(page, 'Doing').getByText('Keyboard card')).toBeVisible();
  await page.reload();
  await expect(cardsIn(page, 'Doing').getByText('Keyboard card')).toBeVisible();
});

test('reorders columns and keeps the order after a reload', async ({ page, project }) => {
  await open(page, project);
  const names = page.locator('main section h2');
  await expect(names).toHaveText(['To do', 'Doing', 'Done']);
  // Mouse first, while the layout is still: positions are measured before the drag.
  await drag(page, page.getByRole('button', { name: 'Move column Doing' }), column(page, 'To do'), column(page, 'Doing'));
  await expect(names).toHaveText(['Doing', 'To do', 'Done']);

  await keyboardMove(page, page.getByRole('button', { name: 'Move column Done' }), [
    { key: 'ArrowLeft', over: 'To do' },
    { key: 'ArrowLeft', over: 'Doing' },
  ]);
  await expect(names).toHaveText(['Done', 'Doing', 'To do']);
  await page.reload();
  await expect(names).toHaveText(['Done', 'Doing', 'To do']);
});

test('shows when a card in the done column expires', async ({ page, request, project }) => {
  const done = (await columnsOf(request, project)).find((c) => c.isDone)!;
  const res = await request.post(`/api/projects/${project.id}/cards`, {
    data: { columnId: done.id, rank: 'a0', title: 'Finished' },
  });
  expect(res.status()).toBe(201);
  await open(page, project);
  await expect(cardsIn(page, 'Done').getByRole('listitem')).toContainText('Expires in 7 days');
});

test('switches theme and remembers it', async ({ page, project }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, project);
  const html = page.locator('html');
  const theme = page.getByRole('group', { name: 'Theme' });
  await expect(html).not.toHaveClass(/dark/);
  await theme.getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(theme.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

  await theme.getByRole('button', { name: 'System' }).click();
  await expect(html).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/dark/);
});

test('opens the project list from a menu on narrow screens', async ({ page, request, project }) => {
  const other = await newProject(request, unique('e2e other'));
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, project);
    await expect(page.getByRole('navigation', { name: 'Projects' })).toBeHidden();
    await page.getByRole('button', { name: 'Open projects' }).click();
    const sheet = page.getByRole('dialog', { name: 'Projects' });
    await sheet.getByRole('button', { name: other.name }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(other.name);
  } finally {
    await request.delete(`/api/projects/${other.id}`);
  }
});

test('renders project, column, and card text literally, never as HTML', async ({ page, request }) => {
  const payload = (where: string) => unique(`<img src=x onerror="window.__xss='${where}'">`);
  const project = await newProject(request, payload('project'));
  try {
    const columnName = payload('column').slice(0, 40);
    const title = payload('card');
    const created = await request.post(`/api/projects/${project.id}/columns`, {
      data: { name: columnName, rank: 'a3' },
    });
    expect(created.status()).toBe(201);
    const { column: col } = await created.json();
    await request.post(`/api/projects/${project.id}/cards`, { data: { columnId: col.id, rank: 'a0', title } });

    await open(page, project);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(project.name);
    await expect(page.getByRole('navigation', { name: 'Projects' }).getByText(project.name)).toBeVisible();
    await expect(page.locator('main section h2').last()).toHaveText(col.name);
    await expect(card(page, title)).toBeVisible();
    expect(await page.locator('main img, nav img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: string }).__xss)).toBeUndefined();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the board has no detectable accessibility violations (${scheme})`, async ({ page, project }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, project);
    await addCards(page, 'To do', ['An accessible card']);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
}
