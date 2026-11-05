import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';
const DRAFT_ID = 'binder-design';

interface DraftBody {
  name: string;
  workflow: {
    version: number;
    id?: string;
    name?: string;
    nodes: Array<{ id: string; label: string; parameters: Record<string, unknown> }>;
    edges: Array<Record<string, unknown>>;
  };
  layout: {
    version: number;
    positions: Record<string, { x: number; y: number }>;
    viewport: { x: number; y: number; zoom: number };
    selection: { nodeId: string | null; edgeId: string | null };
  };
  revision: number;
}

const LAYOUT = {
  version: 1,
  positions: {
    'node-target': { x: 40, y: 40 },
    'node-generator': { x: 260, y: 40 },
    'node-designer': { x: 480, y: 40 },
    'node-predictor': { x: 40, y: 200 },
    'node-comparison': { x: 260, y: 200 },
  },
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

function buildWorkflow(fileReference: {
  id: string;
  path: string;
  name: string;
}) {
  const node = (
    id: string,
    manifestId: string,
    label: string,
    parameters: Record<string, unknown>,
  ) => ({ id, manifestId, manifestVersion: '1.0.0', label, parameters, resources: {} });

  const edge = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ) => ({ id, source, sourcePort, target, targetPort });

  return {
    version: 1,
    id: DRAFT_ID,
    name: 'Binder design',
    nodes: [
      node('node-target', 'target-input', 'Target input', {
        targetFile: {
          fileReferenceId: fileReference.id,
          path: fileReference.path,
          name: fileReference.name,
        },
        targetChain: 'A',
        hotspotResidues: '',
      }),
      node('node-generator', 'candidate-generation', 'Candidate generation', {
        numCandidates: 100,
        seed: 42,
        strategy: 'random',
        useTargetHotspots: true,
        designNote: '',
      }),
      node('node-designer', 'sequence-design', 'Sequence design', {
        model: 'vhh-designer-v1',
        temperature: 0.7,
        numDesigns: 50,
        randomSeed: 7,
        trimTerminalTags: true,
      }),
      node('node-predictor', 'structure-prediction', 'Structure prediction', {
        predictor: 'esmfold2',
        recycles: 3,
        batchSize: 4,
        seed: 1,
      }),
      node('node-comparison', 'candidate-comparison', 'Candidate comparison', {
        topN: 10,
        rankingMetric: 'plddt',
        deduplicate: true,
        label: 'round-1',
      }),
    ],
    edges: [
      edge('e-target-data', 'node-target', 'target', 'node-generator', 'target'),
      edge('e-target-control', 'node-target', 'control-out', 'node-generator', 'control-in'),
      edge('e-generator-data', 'node-generator', 'candidates', 'node-designer', 'candidates'),
      edge('e-generator-control', 'node-generator', 'control-out', 'node-designer', 'control-in'),
      edge('e-designer-data', 'node-designer', 'designs', 'node-predictor', 'designs'),
      edge('e-designer-control', 'node-designer', 'control-out', 'node-predictor', 'control-in'),
      edge('e-predictor-data', 'node-predictor', 'scored', 'node-comparison', 'scored'),
      edge('e-predictor-control', 'node-predictor', 'control-out', 'node-comparison', 'control-in'),
    ],
  };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
}

async function getDraft(page: Page): Promise<DraftBody> {
  const response = await page.request.get(`/api/workflows/${DRAFT_ID}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function seedDraft(page: Page): Promise<void> {
  const registered = await page.request.post('/api/files', {
    data: { path: 'inputs/candidates.fasta' },
  });
  expect(registered.ok()).toBe(true);
  const fileReference = (await registered.json()) as {
    id: string;
    path: string;
    name: string;
  };

  const saved = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: {
      name: 'Binder design',
      workflow: buildWorkflow(fileReference),
      layout: LAYOUT,
    },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('canvas-node-count')).toHaveText('5 Nodes');
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await seedDraft(page);
});

// Leave the shared Project back at an empty draft: later acceptance specs
// assume no pre-existing Workflow content.
test.afterEach(async ({ page }) => {
  await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: {
      name: 'Binder design',
      workflow: { version: 1, nodes: [], edges: [] },
      layout: {
        version: 1,
        positions: {},
        viewport: { x: 0, y: 0, zoom: 0.86 },
        selection: { nodeId: null, edgeId: null },
      },
    },
  });
});

function canvasNode(page: Page, manifestId: string): Locator {
  return page.locator(`[data-testid="canvas-node"][data-manifest-id="${manifestId}"]`);
}

async function selectNode(page: Page, manifestId: string): Promise<void> {
  await canvasNode(page, manifestId).locator('.sflow-node-name').click();
}

async function dragBy(page: Page, locator: Locator, dx: number, dy: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await page.mouse.up();
}

async function proposePatch(
  page: Page,
  summary: string,
  operations: unknown[],
): Promise<void> {
  await page.getByTestId('agent-patch-summary').fill(summary);
  await page.getByTestId('agent-patch-operations').fill(JSON.stringify(operations));
  await page.getByTestId('agent-patch-propose').click();
}

test('offers Workflow and Node Agent modes, activates Node Agent on selection, and records composer messages', async ({
  page,
}) => {
  // No selection: Workflow Agent is the default mode.
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Workflow Agent');
  await expect(page.getByTestId('agent-mode-indicator')).toHaveAttribute(
    'data-mode',
    'workflow',
  );
  await expect(page.getByTestId('agent-context-card')).toContainText('Binder design');
  await expect(page.getByTestId('agent-context-card')).toContainText('5 Nodes');

  // Manual mode switching is available.
  await page.getByTestId('agent-context-node').click();
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');
  await expect(page.getByTestId('agent-mode-indicator')).toHaveAttribute(
    'data-mode',
    'node',
  );
  await expect(page.getByTestId('agent-context-card')).toContainText('Select a Node');

  // Selecting a Node activates Node Agent and updates the visible context.
  await selectNode(page, 'candidate-generation');
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');
  await expect(page.getByTestId('agent-context-card')).toContainText(
    'Candidate generation',
  );
  await expect(page.getByTestId('agent-context-card')).toContainText(
    'candidate-generation',
  );
  await expect(page.getByTestId('node-inspector-title')).toHaveText(
    'Candidate generation',
  );

  // Context, history, and parameters each own their scroll container.
  for (const testId of ['agent-context', 'agent-messages', 'agent-parameters']) {
    const overflow = await page
      .getByTestId(testId)
      .evaluate((element) => getComputedStyle(element).overflowY);
    expect(overflow).toBe('auto');
  }

  // Manual Workflow Agent switching lasts until the next Node selection.
  await page.getByTestId('agent-context-workflow').click();
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Workflow Agent');
  await expect(page.getByTestId('node-inspector')).toHaveCount(0);

  await selectNode(page, 'sequence-design');
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');
  await expect(page.getByTestId('agent-context-card')).toContainText('Sequence design');

  // Enter sends, the conversation is recorded, and the composer stays fixed
  // outside the scrolling history region.
  const composer = page.getByTestId('agent-composer-input');
  await composer.fill('Explain this Node');
  await composer.press('Enter');
  await expect(page.getByTestId('agent-messages')).toContainText('Explain this Node');
  await expect(page.getByTestId('agent-messages')).toContainText('Message recorded');
  await expect(composer).toHaveValue('');

  await composer.fill('Second question');
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-messages')).toContainText('Second question');
});

test('previews, applies, and reverts a validated Agent patch without touching layout state', async ({
  page,
}) => {
  await selectNode(page, 'candidate-generation');
  await page.getByTestId('validate-workflow').click();
  await expect(page.getByTestId('validation-summary')).toHaveText('Workflow is valid.');
  await expect(page.getByTestId('run-workflow')).toBeEnabled();

  const before = await getDraft(page);

  await proposePatch(page, 'Increase candidate count to 250', [
    { op: 'replace', path: '/nodes/1/parameters/numCandidates', value: 250 },
  ]);

  const card = page.getByTestId('agent-patch-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-status', 'proposed');
  await expect(card).toHaveAttribute('data-valid', 'true');
  await expect(page.getByTestId('agent-patch-card-summary')).toHaveText(
    'Increase candidate count to 250',
  );
  await expect(page.getByTestId('agent-patch-target')).toContainText('binder-design');
  await expect(page.getByTestId('agent-patch-target')).toContainText('node-generator');
  await expect(page.getByTestId('agent-patch-base-revision')).toContainText(
    `Base revision ${before.revision}`,
  );
  await expect(page.getByTestId('agent-patch-validation')).toContainText(
    'Schema and semantic validation passed',
  );
  await expect(page.getByTestId('agent-patch-diff')).toContainText('numCandidates');
  await expect(page.getByTestId('agent-patch-diff')).toContainText('250');
  await expect(page.getByTestId('agent-patch-operations-raw')).toContainText(
    '"op": "replace"',
  );
  await expect(page.getByTestId('agent-patch-apply')).toBeEnabled();

  // The proposal is a preview; it never mutates the draft by itself.
  expect((await getDraft(page)).workflow.nodes[1]!.parameters.numCandidates).toBe(100);

  await page.getByTestId('agent-patch-apply').click();
  await expect(card).toHaveAttribute('data-status', 'applied');
  await expect(page.getByTestId('agent-patch-revert')).toBeVisible();
  await expect(page.getByTestId('agent-patch-apply')).toHaveCount(0);

  // The editor document synchronizes with the applied Workflow IR.
  await expect(page.getByTestId('param-numCandidates')).toHaveValue('250');
  const applied = await getDraft(page);
  expect(applied.workflow.nodes[1]!.parameters.numCandidates).toBe(250);
  expect(applied.layout).toEqual(before.layout);
  expect(applied.revision).toBe(before.revision + 1);

  // Any Workflow IR change makes the earlier validation stale and disables Run.
  await expect(page.getByTestId('validation-stale')).toBeVisible();
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await expect(page.getByTestId('global-run')).toBeDisabled();

  // Rollback restores the prior Workflow and layout.
  await page.getByTestId('agent-patch-revert').click();
  await expect(card).toHaveAttribute('data-status', 'reverted');
  await expect(page.getByTestId('param-numCandidates')).toHaveValue('100');

  const reverted = await getDraft(page);
  expect(reverted.workflow.nodes[1]!.parameters.numCandidates).toBe(100);
  expect(reverted.workflow.nodes).toHaveLength(before.workflow.nodes.length);
  expect(reverted.layout).toEqual(before.layout);
  expect(reverted.revision).toBe(before.revision + 2);
});

test('rejects schema and semantic violations in the preview and keeps Apply disabled', async ({
  page,
}) => {
  await selectNode(page, 'candidate-generation');

  await proposePatch(page, 'Set an invalid candidate count', [
    { op: 'replace', path: '/nodes/1/parameters/numCandidates', value: 0 },
  ]);

  const semanticCard = page.getByTestId('agent-patch-card');
  await expect(semanticCard).toHaveAttribute('data-status', 'rejected');
  await expect(semanticCard).toHaveAttribute('data-valid', 'false');
  await expect(page.getByTestId('agent-patch-validation')).toContainText('Rejected');
  await expect(
    page.locator('[data-testid="agent-patch-diagnostic"][data-code="PARAMETER_ERROR"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('agent-patch-apply')).toBeDisabled();
  await expect(page.getByTestId('agent-patch-revert')).toHaveCount(0);

  // A layout-shaped field cannot leak into Workflow IR through an Agent patch.
  await proposePatch(page, 'Leak layout state into Workflow IR', [
    { op: 'add', path: '/positions', value: {} },
  ]);

  const schemaCard = page.getByTestId('agent-patch-card').nth(1);
  await expect(schemaCard).toHaveAttribute('data-status', 'rejected');
  await expect(
    schemaCard.locator('[data-testid="agent-patch-diagnostic"][data-code="INVALID_WORKFLOW"]'),
  ).toHaveCount(1);
  await expect(schemaCard.getByTestId('agent-patch-apply')).toBeDisabled();

  expect((await getDraft(page)).workflow.nodes[1]!.parameters.numCandidates).toBe(100);
});

test('explains a stale-base conflict instead of silently rebasing an applied patch', async ({
  page,
}) => {
  await selectNode(page, 'candidate-generation');
  await expect
    .poll(async () => (await getDraft(page)).layout.selection.nodeId)
    .toBe('node-generator');

  const before = await getDraft(page);
  await proposePatch(page, 'Increase candidate count', [
    { op: 'replace', path: '/nodes/1/parameters/numCandidates', value: 250 },
  ]);
  const card = page.getByTestId('agent-patch-card');
  await expect(card).toHaveAttribute('data-status', 'proposed');

  // A manual edit changes the draft Workflow IR and advances the revision.
  await page.getByTestId('param-numCandidates').fill('140');
  await expect
    .poll(async () => (await getDraft(page)).workflow.nodes[1]!.parameters.numCandidates, {
      timeout: 10_000,
    })
    .toBe(140);
  const changed = await getDraft(page);
  expect(changed.revision).toBeGreaterThan(before.revision);

  await page.getByTestId('agent-patch-apply').click();
  await expect(page.getByTestId('agent-patch-conflict')).toBeVisible();
  await expect(page.getByTestId('agent-patch-conflict')).toContainText('not rebased');
  await expect(card).toHaveAttribute('data-status', 'proposed');

  // Nothing was applied: the user's edit survives and the patch stays pending.
  const after = await getDraft(page);
  expect(after.workflow.nodes[1]!.parameters.numCandidates).toBe(140);
  expect(after.revision).toBe(changed.revision);
  expect(after.layout).toEqual(before.layout);
});

test('presents the Agent as a draggable floating ball and resizable panel, preserving editing context across maximize', async ({
  page,
}) => {
  await selectNode(page, 'candidate-generation');
  await page.getByTestId('canvas-zoom-in').click();
  await expect
    .poll(async () => (await getDraft(page)).layout.selection.nodeId)
    .toBe('node-generator');

  const before = await getDraft(page);
  const viewportBefore = await page.getByTestId('workflow-canvas').evaluate((element) => ({
    x: element.getAttribute('data-viewport-x'),
    y: element.getAttribute('data-viewport-y'),
    zoom: element.getAttribute('data-zoom'),
  }));
  const selectionBefore = await page.getByTestId('canvas-selection').textContent();
  const dockedBox = await page.getByTestId('agent-panel').boundingBox();
  expect(dockedBox).not.toBeNull();
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');

  // Entering maximize swaps the docked panel for a floating ball.
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-panel')).toHaveCount(0);
  await expect(page.getByTestId('agent-ball')).toBeVisible();
  await expect(page.getByTestId('workflow-toolbar')).toBeVisible();
  await expect(page.getByTestId('nav-files')).toHaveCount(0);

  // Ball drag uses a movement threshold and never mutates Workflow IR.
  const ballBefore = await page.getByTestId('agent-ball').boundingBox();
  expect(ballBefore).not.toBeNull();
  await dragBy(page, page.getByTestId('agent-ball'), -110, -40);
  const ballAfter = await page.getByTestId('agent-ball').boundingBox();
  expect(ballAfter!.x).toBeLessThan(ballBefore!.x - 60);
  expect(ballAfter!.y).toBeLessThan(ballBefore!.y - 10);
  await expect(page.getByTestId('agent-floating-panel')).toHaveCount(0);

  const afterBallDrag = await getDraft(page);
  expect(afterBallDrag.workflow).toEqual(before.workflow);
  expect(afterBallDrag.layout).toEqual(before.layout);
  expect(afterBallDrag.revision).toBe(before.revision);

  // A click (not a drag) expands the ball into a floating panel.
  await page.getByTestId('agent-ball').click();
  await expect(page.getByTestId('agent-floating-panel')).toBeVisible();
  await expect(page.getByTestId('agent-ball')).toHaveCount(0);
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');

  // The panel drags by its header and resizes from its corner/edge handles.
  const panelBefore = await page.getByTestId('agent-floating-panel').boundingBox();
  expect(panelBefore).not.toBeNull();
  await dragBy(page, page.getByTestId('agent-float-header'), 40, 24);
  const panelMoved = await page.getByTestId('agent-floating-panel').boundingBox();
  expect(panelMoved!.x).toBeGreaterThan(panelBefore!.x + 20);
  expect(panelMoved!.y).toBeGreaterThan(panelBefore!.y + 10);

  await dragBy(page, page.getByTestId('agent-resize-se'), 80, 60);
  const panelResized = await page.getByTestId('agent-floating-panel').boundingBox();
  expect(panelResized!.width).toBeGreaterThan(panelMoved!.width + 50);
  expect(panelResized!.height).toBeGreaterThan(panelMoved!.height + 30);

  // Collapse returns to the ball; the panel can be reopened.
  await page.getByTestId('agent-float-collapse').click();
  await expect(page.getByTestId('agent-floating-panel')).toHaveCount(0);
  await expect(page.getByTestId('agent-ball')).toBeVisible();
  await page.getByTestId('agent-ball').click();
  await expect(page.getByTestId('agent-floating-panel')).toBeVisible();

  // The expanded floating state survives an exit and re-entry.
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('agent-floating-panel')).toHaveCount(0);

  // Docked panel proportions, selection, zoom, viewport, and Node positions
  // are exactly what they were before maximize.
  const dockedAfter = await page.getByTestId('agent-panel').boundingBox();
  expect(dockedAfter!.width).toBeCloseTo(dockedBox!.width, 0);
  const viewportAfter = await page.getByTestId('workflow-canvas').evaluate((element) => ({
    x: element.getAttribute('data-viewport-x'),
    y: element.getAttribute('data-viewport-y'),
    zoom: element.getAttribute('data-zoom'),
  }));
  expect(viewportAfter).toEqual(viewportBefore);
  expect(await page.getByTestId('canvas-selection').textContent()).toBe(selectionBefore);
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');

  const restored = await getDraft(page);
  expect(restored.workflow).toEqual(before.workflow);
  expect(restored.layout).toEqual(before.layout);

  // Re-entering maximize restores the floating presentation state.
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-floating-panel')).toBeVisible();
  await page.getByTestId('agent-float-collapse').click();
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();

  // A collapsed Agent stays a rail in maximize, and expanding it there
  // produces the floating ball without losing the docked expansion state.
  await page.getByRole('button', { name: 'Collapse agent panel' }).click();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await expect(page.getByTestId('agent-ball')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand agent panel' }).click();
  await expect(page.getByTestId('agent-ball')).toBeVisible();
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('agent-rail')).toHaveCount(0);
});
