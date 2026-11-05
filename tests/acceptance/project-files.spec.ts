import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
}

test('expands the Project tree and selects a path-backed File Reference', async ({ page }) => {
  await signIn(page);

  const explorer = page.getByTestId('explorer-panel');
  await expect(explorer).toBeVisible();
  await expect(page.getByTestId('file-entry-inputs')).toBeVisible();

  // Directories expand in place; they are not a current-path navigation.
  await expect(page.getByTestId('file-entry-inputs/candidates.fasta')).toHaveCount(0);
  await page.getByTestId('file-entry-inputs').click();
  await expect(page.getByTestId('file-entry-inputs')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('file-entry-inputs/candidates.fasta')).toBeVisible();

  // Expansion is independent per directory and nests.
  await page.getByTestId('file-entry-designs').click();
  await page.getByTestId('file-entry-designs/round-1').click();
  await expect(page.getByTestId('file-entry-designs/round-1/design-001.pdb')).toBeVisible();

  await page.getByTestId('file-entry-inputs/candidates.fasta').click();
  await expect(page.getByTestId('file-entry-inputs/candidates.fasta')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );

  // Selecting an arbitrary Project file never opens it as a document tab.
  const tabs = page.getByTestId('workflow-tabs').getByRole('tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText('Binder design');
  await expect(page.getByTestId('workflow-tabs').getByText('candidates.fasta')).toHaveCount(0);

  // The File Reference exposes its Project filesystem path through the API.
  const response = await page.request.get('/api/files/references');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    references: Array<{ path: string; id: string; name: string }>;
  };
  expect(body.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'inputs/candidates.fasta',
        name: 'candidates.fasta',
      }),
    ]),
  );
  expect(body.references[0]).not.toHaveProperty('sha256');

  // The Files section surfaces the path-only reference.
  await page.getByTestId('nav-files').click();
  await expect(page.getByTestId('file-reference-path')).toHaveText('inputs/candidates.fasta');
  await expect(page.getByTestId('file-reference-id')).not.toBeEmpty();
  await expect(page.getByText('Path-only reference')).toBeVisible();

  // Returning to Workflows keeps the reference selected and the tab set unchanged.
  await page.getByTestId('nav-workflows').click();
  await expect(page.getByTestId('workflow-tabs').getByRole('tab')).toHaveCount(1);
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );

  // Collapsing and re-expanding the explorer preserves selected-file state.
  await page.getByRole('button', { name: 'Collapse file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );
});

test('scrolls the Project file tree independently of the editor and document', async ({
  page,
}) => {
  await signIn(page);

  const tree = page.getByTestId('explorer-tree-scroll');
  await expect(tree).toBeVisible();

  const sizes = await tree.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight + 20);

  const box = await tree.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 600);

  await expect
    .poll(async () => tree.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  const layout = await page.evaluate(() => ({
    windowScrollY: window.scrollY,
    documentScrollHeight: document.documentElement.scrollHeight,
    documentClientHeight: document.documentElement.clientHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
  }));
  expect(layout.windowScrollY).toBe(0);
  expect(layout.documentScrollHeight).toBeLessThanOrEqual(layout.documentClientHeight + 1);
  expect(layout.bodyOverflow).toBe('hidden');

  // The Workflow editor did not scroll with the tree and stays usable.
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('workflow-tabs')).toBeVisible();
  await expect(page.getByTestId('workflow-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  expect(
    await page.getByTestId('workflow-canvas').evaluate((element) => element.scrollTop),
  ).toBe(0);
});

test('keeps the Workflow editor accessible when the explorer collapses or the window narrows', async ({
  page,
}) => {
  await signIn(page);

  await page.getByTestId('file-entry-inputs').click();
  await page.getByTestId('file-entry-inputs/candidates.fasta').click();
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );

  await page.getByRole('button', { name: 'Collapse file explorer' }).click();
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('workflow-tabs')).toBeVisible();
  await expect(page.getByTestId('workflow-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Expand file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();

  // Narrow: the explorer collapses before the editor and can still be opened
  // manually while the Workflow surface remains reachable.
  await page.setViewportSize({ width: 800, height: 700 });
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('workflow-tabs')).toBeVisible();
  await expect(page.getByTestId('workflow-toolbar')).toBeVisible();

  await page.setViewportSize({ width: 700, height: 640 });
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('workflow-tabs')).toBeVisible();

  await page.getByRole('button', { name: 'Expand file explorer' }).click();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();
  await expect(page.getByTestId('editor-panel')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight + 1);
});
