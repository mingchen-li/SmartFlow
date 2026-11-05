import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';
const DRAFT_ID = 'binder-design';

const EMPTY_WORKFLOW = { version: 1, nodes: [], edges: [] };
const EMPTY_LAYOUT = {
  version: 1,
  positions: {},
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
}

/**
 * Project-scoped custom Node installation from the Web workspace. The package
 * is seeded in the Project filesystem by the Playwright configuration; the
 * install action and its validation diagnostics stay inside the fixed Node
 * Library modal.
 */
test('installs, surfaces, and inserts a Project Node package from the Node Library', async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId('nav-node-library').click();

  const library = page.getByTestId('node-library');
  await expect(library).toBeVisible();
  const box = await library.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(720);
  expect(box!.height).toBeLessThanOrEqual(560);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);

  try {
    await page.getByTestId('node-library-install-toggle').click();
    await expect(page.getByTestId('node-library-install-form')).toBeVisible();

    // An invalid package path yields actionable diagnostics in place and does
    // not change the catalog.
    await page.getByTestId('node-library-install-path').fill('node-packages/missing-node');
    await page.getByTestId('node-library-install-submit').click();
    const error = page.getByTestId('node-library-install-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('node-packages/missing-node');
    await expect(page.getByTestId('node-library-install-diagnostics')).toContainText('path');
    await expect(page.getByTestId('node-library-result-count')).toHaveText('5 Nodes');

    await page.getByTestId('node-library-install-path').fill('node-packages/echo-node');
    await page.getByTestId('node-library-install-submit').click();

    await expect(page.getByTestId('node-library-install-notice')).toHaveText(
      'Installed Echo Node 1.0.0.',
    );
    await expect(page.getByTestId('node-library-result-count')).toHaveText('6 Nodes');
    await expect(page.getByTestId('node-library-count-all')).toHaveText('6');

    // Installed Nodes are marked and expose their Manifest execution metadata.
    await expect(page.getByTestId('node-library-node-echo-node')).toBeVisible();
    await expect(page.getByTestId('node-library-installed-echo-node')).toHaveText('Installed');
    await expect(page.getByTestId('node-library-environment-echo-node')).toContainText(
      'ghcr.io/sflow/examples/echo-node:1.0.0',
    );
    await expect(page.getByTestId('node-library-environment-echo-node')).toContainText(
      'retry 1',
    );
    await expect(page.getByTestId('node-library-source-echo-node')).toHaveText(
      '.sflow/nodes/echo-node/1.0.0',
    );

    // The installed Node is immediately insertable into the Workflow.
    await page.getByTestId('node-library-node-echo-node').click();
    await expect(library).toHaveCount(0);
    await expect(
      page.locator('[data-testid="canvas-node"][data-manifest-id="echo-node"]'),
    ).toHaveCount(1);
  } finally {
    // The Project Server is shared by every acceptance spec; remove the
    // installed package and restore the empty draft even when an assertion
    // above fails.
    await page.request.delete('/api/nodes/echo-node');
    await page.request.put(`/api/workflows/${DRAFT_ID}`, {
      data: { name: 'Binder design', workflow: EMPTY_WORKFLOW, layout: EMPTY_LAYOUT },
    });
  }
});
