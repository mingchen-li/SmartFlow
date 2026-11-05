import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';
const ROTATED_PASSWORD = 'e2e-password-rotated';

async function signIn(page: Page, credential = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(credential);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
}

test('requires authentication before opening the workspace', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to your Project' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  expect(await page.locator('[data-testid="language-switcher"]').count()).toBe(0);
  expect(await page.locator('body').innerText()).not.toMatch(/[一-鿿]/);

  const rejected = page.waitForResponse((response) => response.url().endsWith('/api/auth/login'));
  await page.getByLabel('Project credential').fill('not-the-credential');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  expect((await rejected).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText('Invalid Project credential.');

  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();

  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('project-name')).not.toBeEmpty();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('rejects unauthenticated Project API requests', async ({ request }) => {
  expect((await request.get('/api/project')).status()).toBe(401);
  expect((await request.get('/api/files')).status()).toBe(401);
  expect((await request.get('/api/workflows/binder-design')).status()).toBe(401);
});

test('fills the viewport without document scrolling', async ({ page }) => {
  await signIn(page);

  const metrics = await page.evaluate(() => {
    window.scrollTo(0, 500);
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollY: window.scrollY,
    };
  });

  expect(metrics.bodyOverflow).toBe('hidden');
  expect(metrics.htmlOverflow).toBe('hidden');
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight + 1);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.scrollY).toBe(0);

  await expect(page.getByTestId('primary-nav')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  await expect(page.getByTestId('monitor-cards').locator('.card')).toHaveCount(3);
});

test('uses the SFlow text brand, English copy, and no avatar or logo assets', async ({ page }) => {
  await signIn(page);

  const toolbar = page.getByTestId('global-toolbar');
  await expect(toolbar.getByTestId('brand')).toHaveText('SFlow');
  await expect(toolbar.getByTestId('project-name')).not.toBeEmpty();
  await expect(toolbar.getByTestId('project-state')).toHaveText('Idle');
  await expect(toolbar.getByRole('button', { name: /^Save/ })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

  // English-only product copy: no language switcher and no Chinese characters.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  expect(await page.locator('[data-testid="language-switcher"]').count()).toBe(0);
  expect(await page.locator('body').innerText()).not.toMatch(/[一-鿿]/);

  const navLabels = [
    ['nav-files', 'Files'],
    ['nav-workflows', 'Workflows'],
    ['nav-node-library', 'Node Library'],
    ['nav-terminal', 'Terminal'],
    ['nav-runs', 'Runs'],
  ] as const;

  for (const [testId, label] of navLabels) {
    await expect(page.getByTestId(testId)).toHaveText(label);
  }

  // Primary navigation is vertical: every item shares one column and they
  // proceed from top to bottom.
  const navPositions = await page.getByTestId('primary-nav').evaluate((nav) =>
    [...nav.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    }),
  );
  expect(new Set(navPositions.map((position) => position.x)).size).toBe(1);
  for (let index = 1; index < navPositions.length; index += 1) {
    expect(navPositions[index].y).toBeGreaterThan(navPositions[index - 1].y);
  }

  await expect(page.getByTestId('open-settings')).toHaveText('Project settings');
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('[class*="avatar" i]').count()).toBe(0);
});

test('resizes and collapses the file explorer and Agent panels', async ({ page }) => {
  await signIn(page);

  await expect(page.getByTestId('editor-panel')).toBeVisible();
  const editorBefore = await page.getByTestId('editor-panel').boundingBox();
  expect(editorBefore).not.toBeNull();

  const explorer = page.getByTestId('explorer-panel');
  const explorerBefore = await explorer.boundingBox();
  const explorerHandle = await page.getByTestId('explorer-resizer').boundingBox();
  expect(explorerBefore).not.toBeNull();
  expect(explorerHandle).not.toBeNull();

  await page.mouse.move(
    explorerHandle!.x + explorerHandle!.width / 2,
    explorerHandle!.y + explorerHandle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    explorerHandle!.x + explorerHandle!.width / 2 + 60,
    explorerHandle!.y + explorerHandle!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();

  await expect
    .poll(async () => (await explorer.boundingBox())?.width ?? 0)
    .toBeGreaterThan(explorerBefore!.width + 40);

  await page.getByRole('button', { name: 'Collapse file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  await expect(page.getByTestId('explorer-rail')).toBeVisible();

  // The editor owns the flexible space released by the collapsed panel.
  await expect
    .poll(async () => (await page.getByTestId('editor-panel').boundingBox())?.width ?? 0)
    .toBeGreaterThan(editorBefore!.width + 100);

  await page.getByRole('button', { name: 'Expand file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();

  const agentBefore = await page.getByTestId('agent-panel').boundingBox();
  expect(agentBefore).not.toBeNull();
  const agentHandle = await page.getByTestId('agent-resizer').boundingBox();
  expect(agentHandle).not.toBeNull();

  await page.mouse.move(
    agentHandle!.x + agentHandle!.width / 2,
    agentHandle!.y + agentHandle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    agentHandle!.x + agentHandle!.width / 2 - 60,
    agentHandle!.y + agentHandle!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();

  await expect
    .poll(async () => (await page.getByTestId('agent-panel').boundingBox())?.width ?? 0)
    .toBeGreaterThan(agentBefore!.width + 40);

  await page.getByRole('button', { name: 'Collapse agent panel' }).click();
  await expect(page.getByTestId('agent-panel')).toHaveCount(0);
  await expect(page.getByTestId('agent-rail')).toBeVisible();

  await page.getByRole('button', { name: 'Expand agent panel' }).click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
});

test('collapses secondary panels and keeps monitor cards available at narrow widths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await signIn(page);

  // The explorer yields before the Agent; the editor stays usable.
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('agent-panel')).toBeVisible();

  await page.setViewportSize({ width: 700, height: 640 });

  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  await expect(page.getByTestId('monitor-cards').locator('.card')).toHaveCount(3);

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.innerHeight + 1);

  const monitor = await page.getByTestId('run-monitor').boundingBox();
  const cards = await page.getByTestId('monitor-cards').boundingBox();
  expect(monitor).not.toBeNull();
  expect(cards).not.toBeNull();
  expect(cards!.x + cards!.width).toBeLessThanOrEqual(monitor!.x + monitor!.width + 1);

  // Cards either stack onto multiple rows or the monitor body scrolls; they
  // never disappear when the viewport narrows.
  const cardLayout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="monitor-cards"] .card')];
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)));
    const body = document.querySelector('.run-monitor-body');
    const scrollable = body !== null && body.scrollHeight > body.clientHeight + 1;
    return { rows: rows.size, scrollable };
  });
  expect(cardLayout.rows > 1 || cardLayout.scrollable).toBe(true);
});

test('saves the Workflow draft from the global toolbar', async ({ page }) => {
  await signIn(page);

  await page.getByRole('button', { name: 'Save Binder design' }).click();
  await expect(page.getByTestId('toast')).toHaveText('Draft saved.');

  const response = await page.request.get('/api/workflows/binder-design');
  expect(response.ok()).toBe(true);
  const draft = (await response.json()) as { name: string; workflow: unknown };
  expect(draft.name).toBe('Binder design');
  expect(draft.workflow).toEqual({ version: 1, nodes: [], edges: [] });
});

// Keep this last: it changes the Project credential for this suite.
test('rotates the Project credential from Project settings', async ({ page }) => {
  await signIn(page);

  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Current credential', { exact: true }).fill(PASSWORD);
  await dialog.getByLabel('New credential', { exact: true }).fill(ROTATED_PASSWORD);
  await dialog.getByLabel('Confirm new credential', { exact: true }).fill(ROTATED_PASSWORD);
  await dialog.getByRole('button', { name: 'Rotate credential' }).click();

  await expect(dialog.getByRole('status')).toHaveText('Project credential rotated.');

  await dialog.getByRole('button', { name: 'Close project settings' }).click();
  await page.getByTestId('open-settings').click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByLabel('Project credential')).toBeVisible();
  await page.getByLabel('Project credential').fill(ROTATED_PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();

  // Restore the suite credential so later runs against a fresh Project are
  // unaffected either way.
  await page.getByTestId('open-settings').click();
  const restore = page.getByTestId('settings-dialog');
  await restore.getByLabel('Current credential', { exact: true }).fill(ROTATED_PASSWORD);
  await restore.getByLabel('New credential', { exact: true }).fill(PASSWORD);
  await restore.getByLabel('Confirm new credential', { exact: true }).fill(PASSWORD);
  await restore.getByRole('button', { name: 'Rotate credential' }).click();
  await expect(restore.getByRole('status')).toHaveText('Project credential rotated.');
});
