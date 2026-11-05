import { expect, test, type Locator, type Page } from '@playwright/test';

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

// The Project Server (and its draft) is shared by the whole worker, so every
// editor test starts from an empty draft rather than whatever the last test
// autosaved.
test.beforeEach(async ({ page }) => {
  await signIn(page);
  const response = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: 'Binder design', workflow: EMPTY_WORKFLOW, layout: EMPTY_LAYOUT },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
});

function canvasNode(page: Page, manifestId: string): Locator {
  return page.locator(`[data-testid="canvas-node"][data-manifest-id="${manifestId}"]`);
}

async function insertNode(page: Page, manifestId: string): Promise<void> {
  await page.getByTestId('open-node-library').click();
  const library = page.getByTestId('node-library');
  await expect(library).toBeVisible();
  await page.getByTestId(`node-library-node-${manifestId}`).click();
  await expect(library).toHaveCount(0);
  await expect(canvasNode(page, manifestId).first()).toBeVisible();
}

async function connect(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
}

async function getDraft(page: Page): Promise<{
  name: string;
  workflow: {
    version: number;
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  layout: Record<string, unknown>;
}> {
  const response = await page.request.get(`/api/workflows/${DRAFT_ID}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function pollDraft(
  page: Page,
  check: (draft: Awaited<ReturnType<typeof getDraft>>) => boolean,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/workflows/${DRAFT_ID}`);
      if (!response.ok()) return false;
      return check(await response.json());
    }, { timeout: 10_000 })
    .toBe(true);
}

test('browses, searches, and inserts configured Nodes from the Node Library', async ({ page }) => {
  await expect(page.getByTestId('canvas-node-count')).toHaveText('0 Nodes');
  await page.getByTestId('nav-node-library').click();

  const library = page.getByTestId('node-library');
  await expect(library).toBeVisible();
  await expect(library).toHaveAttribute('role', 'dialog');
  await expect(library).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByTestId('node-library-search')).toBeFocused();

  // Category counts are computed from Manifest metadata.
  await expect(page.getByTestId('node-library-count-all')).toHaveText('5');
  await expect(page.getByTestId('node-library-count-inputs')).toHaveText('1');
  await expect(page.getByTestId('node-library-count-protein-design')).toHaveText('2');
  await expect(page.getByTestId('node-library-count-structure-prediction')).toHaveText('1');
  await expect(page.getByTestId('node-library-count-analysis')).toHaveText('1');
  await expect(page.getByTestId('node-library-result-count')).toHaveText('5 Nodes');

  // Search matches Node type and description as well as name.
  await page.getByTestId('node-library-search').fill('predictor');
  await expect(page.getByTestId('node-library-result-count')).toHaveText('1 Node');
  await expect(page.getByTestId('node-library-node-structure-prediction')).toBeVisible();
  await expect(page.getByTestId('node-library-node-sequence-design')).toHaveCount(0);

  await page.getByTestId('node-library-search').fill('VHH');
  await expect(page.getByTestId('node-library-node-sequence-design')).toBeVisible();
  await expect(page.getByTestId('node-library-result-count')).toHaveText('1 Node');

  // Empty result state.
  await page.getByTestId('node-library-search').fill('no such node');
  await expect(page.getByTestId('node-library-result-count')).toHaveText('0 Nodes');
  await expect(page.getByTestId('node-library-empty')).toContainText('No matching Nodes');
  await expect(page.getByTestId('node-library-empty')).toContainText(
    'Try another keyword or category.',
  );

  // Category and query combine with AND.
  await page.getByTestId('node-library-search').fill('');
  await page.getByTestId('node-library-category-protein-design').click();
  await expect(page.getByTestId('node-library-result-count')).toHaveText('2 Nodes');
  await page.getByTestId('node-library-search').fill('sequence');
  await expect(page.getByTestId('node-library-result-count')).toHaveText('1 Node');

  // Inserting a Manifest creates a configured instance and selects it.
  await page.getByTestId('node-library-node-sequence-design').click();
  await expect(library).toHaveCount(0);
  await expect(page.getByTestId('canvas-node-count')).toHaveText('1 Node');

  const inserted = canvasNode(page, 'sequence-design');
  await expect(inserted).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Sequence design');
  await expect(page.getByTestId('param-model')).toHaveValue('vhh-designer-v1');
  await expect(page.getByTestId('param-numDesigns')).toHaveValue('50');
  await expect(page.getByTestId('inspector-ports')).toContainText('candidates');
  await expect(page.getByTestId('inspector-metrics')).toContainText('Mean sequence confidence');

  // Duplicate creates a second instance of the same Manifest and selects it.
  await page.getByTestId('duplicate-node').click();
  await expect(page.getByTestId('canvas-node-count')).toHaveText('2 Nodes');
  await expect(canvasNode(page, 'sequence-design')).toHaveCount(2);
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Sequence design copy');
  await expect(canvasNode(page, 'sequence-design').nth(1)).toHaveAttribute(
    'data-selected',
    'true',
  );

  await pollDraft(
    page,
    (draft) =>
      draft.workflow.nodes.length === 2 &&
      draft.workflow.nodes.every((node) => node.manifestId === 'sequence-design'),
  );
});
test('connects valid data and control edges and persists layout without polluting Workflow IR', async ({
  page,
}) => {
  await insertNode(page, 'target-input');
  await insertNode(page, 'candidate-generation');
  await expect(page.getByTestId('canvas-node-count')).toHaveText('2 Nodes');

  const inputNode = canvasNode(page, 'target-input');
  const generatorNode = canvasNode(page, 'candidate-generation');

  // Data edge: target structure -> candidate generation target.
  await connect(
    page,
    inputNode.getByTestId('port-target-output'),
    generatorNode.getByTestId('port-target-input'),
  );
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('1 Edge');

  // Control edge: execution ordering.
  await connect(
    page,
    inputNode.getByTestId('port-control-out-output'),
    generatorNode.getByTestId('port-control-in-input'),
  );
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('2 Edges');

  // Invalid control-to-data connection is rejected by the Manifest contract.
  await connect(
    page,
    inputNode.getByTestId('port-control-out-output'),
    generatorNode.getByTestId('port-target-input'),
  );
  await page.waitForTimeout(300);
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('2 Edges');

  // Selecting the Node exposes its generated configuration.
  await inputNode.locator('.sflow-node-name').click();
  await expect(inputNode).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  await expect(page.getByTestId('canvas-selection')).toContainText('Target input');

  // Move the Node; positions are layout state, not Workflow IR.
  const flowXBefore = Number(await inputNode.getAttribute('data-flow-x'));
  const titleBox = await inputNode.locator('.sflow-node-name').boundingBox();
  expect(titleBox).not.toBeNull();
  await page.mouse.move(
    titleBox!.x + titleBox!.width / 2,
    titleBox!.y + titleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    titleBox!.x + titleBox!.width / 2 + 70,
    titleBox!.y + titleBox!.height / 2 + 30,
    { steps: 10 },
  );
  await page.mouse.up();

  await expect
    .poll(async () => Number(await inputNode.getAttribute('data-flow-x')))
    .toBeGreaterThan(flowXBefore + 20);
  const flowXAfter = Number(await inputNode.getAttribute('data-flow-x'));

  // Zoom is exposed and persisted with the layout.
  await page.getByTestId('canvas-zoom-in').click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId('workflow-canvas').getAttribute('data-zoom')),
    )
    .toBeGreaterThan(0.86);
  const zoomAfter = Number(
    await page.getByTestId('workflow-canvas').getAttribute('data-zoom'),
  );
  const viewportX = Number(
    await page.getByTestId('workflow-canvas').getAttribute('data-viewport-x'),
  );
  const viewportY = Number(
    await page.getByTestId('workflow-canvas').getAttribute('data-viewport-y'),
  );

  // Validate and Run are visible placeholders for ticket #6.
  await page.getByTestId('workflow-toolbar').getByTestId('validate-workflow').click();
  await expect(page.getByTestId('toast')).toHaveText(
    'Workflow validation is not available yet.',
  );
  await page.getByTestId('workflow-toolbar').getByTestId('run-workflow').click();
  await expect(page.getByTestId('toast')).toHaveText('Run creation is not available yet.');

  await pollDraft(
    page,
    (draft) =>
      draft.workflow.nodes.length === 2 &&
      draft.workflow.edges.length === 2 &&
      Number(
        (draft.layout as { positions: Record<string, { x: number }> }).positions[
          String(draft.workflow.nodes.find((node) => node.manifestId === 'target-input')!.id)
        ]?.x,
      ) > flowXBefore,
  );

  const persisted = await getDraft(page);
  const inputPersisted = persisted.workflow.nodes.find(
    (node) => node.manifestId === 'target-input',
  )!;
  const generatorPersisted = persisted.workflow.nodes.find(
    (node) => node.manifestId === 'candidate-generation',
  )!;
  expect(persisted.workflow.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: inputPersisted.id,
        sourcePort: 'target',
        target: generatorPersisted.id,
        targetPort: 'target',
      }),
      expect.objectContaining({
        source: inputPersisted.id,
        sourcePort: 'control-out',
        target: generatorPersisted.id,
        targetPort: 'control-in',
      }),
    ]),
  );

  // Reload restores Nodes, edges, selection, position, zoom, and viewport.
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('canvas-node-count')).toHaveText('2 Nodes');
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('2 Edges');
  await expect(canvasNode(page, 'target-input')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  expect(Number(await canvasNode(page, 'target-input').getAttribute('data-flow-x'))).toBe(
    flowXAfter,
  );
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-zoom',
    String(zoomAfter),
  );
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-viewport-x',
    String(viewportX),
  );
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-viewport-y',
    String(viewportY),
  );

  // Persisted Workflow IR contains execution semantics only.
  expect(Object.keys(persisted.workflow).sort()).toEqual(['edges', 'nodes', 'version']);
  for (const node of persisted.workflow.nodes) {
    expect(Object.keys(node).sort()).toEqual([
      'id',
      'label',
      'manifestId',
      'manifestVersion',
      'parameters',
      'resources',
    ]);
    expect(node).not.toHaveProperty('position');
    expect(node).not.toHaveProperty('selected');
    expect(node).not.toHaveProperty('data');
  }
  expect(Object.keys(persisted.layout).sort()).toEqual([
    'positions',
    'selection',
    'version',
    'viewport',
  ]);
  for (const key of ['maximize', 'libraryQuery', 'libraryCategory', 'panelWidths']) {
    expect(persisted.layout).not.toHaveProperty(key);
  }
});

test('generates parameter and resource forms, selects File References, and autosaves across reloads', async ({
  page,
}) => {
  // Register a path-backed File Reference through the Project explorer.
  await page.getByTestId('file-entry-inputs').click();
  await page.getByTestId('file-entry-inputs/candidates.fasta').click();
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/files/references');
      const body = (await response.json()) as { references: unknown[] };
      return body.references.length;
    })
    .toBe(1);

  await insertNode(page, 'target-input');

  // Required parameter is reported until a File Reference is selected.
  await expect(page.getByTestId('inspector-validation')).toContainText('Target file is required');
  const fileSelect = page.getByTestId('param-targetFile');
  await expect(fileSelect.locator('option')).toHaveCount(2);
  await expect(fileSelect.locator('option').nth(1)).toHaveText('inputs/candidates.fasta');
  await fileSelect.selectOption({ label: 'inputs/candidates.fasta' });
  await expect(fileSelect.locator('option:checked')).toHaveText('inputs/candidates.fasta');
  await expect(page.getByTestId('inspector-validation')).toContainText(
    'All parameters are valid',
  );

  await page.getByTestId('param-targetChain').selectOption('B');

  await insertNode(page, 'candidate-generation');
  await page.getByTestId('param-numCandidates').fill('250');
  await page.getByTestId('param-seed').fill('7');
  await page.getByTestId('param-useTargetHotspots').uncheck();
  await page.getByTestId('param-strategy').selectOption('cdr-focused');

  // Resource overrides are generated from the Manifest defaults.
  await expect(page.getByTestId('resource-cpu')).toHaveAttribute('placeholder', '4');
  await page.getByTestId('resource-cpu').fill('8');
  await page.getByTestId('resource-memory').fill('16Gi');
  await page.getByTestId('resource-gpu').fill('1');
  await page.getByTestId('resource-gpuType').fill('A100');
  await page.getByTestId('resource-walltime').fill('45');

  // Detailed raw configuration view validates before applying.
  await page.getByTestId('inspector-tab-raw').click();
  const raw = page.getByTestId('raw-config');
  const rawConfig = JSON.parse(await raw.inputValue()) as {
    parameters: Record<string, unknown>;
    resources: Record<string, unknown>;
  };
  expect(rawConfig.parameters.numCandidates).toBe(250);
  expect(rawConfig.parameters.useTargetHotspots).toBe(false);
  expect(rawConfig.resources.cpu).toBe(8);
  expect(rawConfig.resources.memory).toBe('16Gi');

  await raw.fill('{');
  await expect(page.getByTestId('raw-config-status')).toContainText('Invalid JSON');
  await expect(page.getByTestId('apply-raw-config')).toBeDisabled();

  const invalidEnum = structuredClone(rawConfig);
  invalidEnum.parameters.strategy = 'not-declared';
  await raw.fill(JSON.stringify(invalidEnum, null, 2));
  await expect(page.getByTestId('raw-config-status')).toContainText('declared options');
  await expect(page.getByTestId('apply-raw-config')).toBeDisabled();

  const valid = structuredClone(rawConfig);
  valid.parameters.numCandidates = 300;
  valid.parameters.strategy = 'cdr-focused';
  valid.resources.cpu = 4;
  await raw.fill(JSON.stringify(valid, null, 2));
  await expect(page.getByTestId('raw-config-status')).toContainText(
    'Configuration is valid',
  );
  await page.getByTestId('apply-raw-config').click();
  await expect(page.getByTestId('param-numCandidates')).toHaveValue('300');
  await expect(page.getByTestId('resource-cpu')).toHaveValue('4');

  await pollDraft(page, (draft) => {
    const generator = draft.workflow.nodes.find(
      (node) => node.manifestId === 'candidate-generation',
    );
    const target = draft.workflow.nodes.find((node) => node.manifestId === 'target-input');
    if (!generator || !target) return false;

    const parameters = generator.parameters as Record<string, unknown>;
    const resources = generator.resources as Record<string, unknown>;
    const targetParameters = target.parameters as {
      targetFile?: { path?: string };
      targetChain?: string;
    };
    return (
      parameters.numCandidates === 300 &&
      parameters.seed === 7 &&
      parameters.strategy === 'cdr-focused' &&
      parameters.useTargetHotspots === false &&
      resources.cpu === 4 &&
      resources.memory === '16Gi' &&
      resources.gpu === 1 &&
      resources.gpuType === 'A100' &&
      resources.walltimeMinutes === 45 &&
      targetParameters.targetFile?.path === 'inputs/candidates.fasta' &&
      targetParameters.targetChain === 'B'
    );
  });

  // Reload restores the draft; the last selection is restored too.
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('canvas-node-count')).toHaveText('2 Nodes');
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Candidate generation');
  await expect(page.getByTestId('param-numCandidates')).toHaveValue('300');
  await expect(page.getByTestId('resource-cpu')).toHaveValue('4');
  await expect(page.getByTestId('resource-memory')).toHaveValue('16Gi');

  await canvasNode(page, 'target-input').locator('.sflow-node-name').click();
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  await expect(page.getByTestId('param-targetFile').locator('option:checked')).toHaveText(
    'inputs/candidates.fasta',
  );
  await expect(page.getByTestId('param-targetChain')).toHaveValue('B');

  // Explicit Save still works alongside debounced autosave.
  await page.getByRole('button', { name: 'Save Binder design' }).click();
  await expect(page.getByTestId('toast')).toHaveText('Draft saved.');
});

test('maximizes the canvas without losing editing context or mutating Workflow IR', async ({
  page,
}) => {
  await insertNode(page, 'target-input');
  await insertNode(page, 'candidate-generation');

  const inputNode = canvasNode(page, 'target-input');
  const generatorNode = canvasNode(page, 'candidate-generation');
  await connect(
    page,
    inputNode.getByTestId('port-target-output'),
    generatorNode.getByTestId('port-target-input'),
  );
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('1 Edge');
  await inputNode.locator('.sflow-node-name').click();
  await page.getByTestId('canvas-zoom-in').click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId('workflow-canvas').getAttribute('data-zoom')),
    )
    .toBeGreaterThan(0.86);

  await pollDraft(
    page,
    (draft) =>
      draft.workflow.nodes.length === 2 &&
      draft.workflow.edges.length === 1 &&
      (draft.layout as { selection: { nodeId: string | null } }).selection.nodeId !== null,
  );
  const workflowBefore = (await getDraft(page)).workflow;

  const flowBefore = {
    x: Number(await inputNode.getAttribute('data-flow-x')),
    y: Number(await inputNode.getAttribute('data-flow-y')),
  };
  const viewportBefore = {
    x: Number(await page.getByTestId('workflow-canvas').getAttribute('data-viewport-x')),
    y: Number(await page.getByTestId('workflow-canvas').getAttribute('data-viewport-y')),
    zoom: Number(await page.getByTestId('workflow-canvas').getAttribute('data-zoom')),
  };
  const canvasBefore = await page.getByTestId('workflow-canvas').boundingBox();
  const explorerBefore = await page.getByTestId('explorer-panel').boundingBox();
  const agentBefore = await page.getByTestId('agent-panel').boundingBox();
  expect(canvasBefore).not.toBeNull();
  expect(explorerBefore).not.toBeNull();
  expect(agentBefore).not.toBeNull();

  // Runtime UI state (Node Library query/category) is not part of the draft.
  let draftPuts = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes(`/api/workflows/${DRAFT_ID}`)) {
      draftPuts += 1;
    }
  });

  await page.getByTestId('open-node-library').click();
  await page.getByTestId('node-library-search').fill('sequence');
  await page.getByTestId('node-library-category-protein-design').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('node-library')).toHaveCount(0);
  await page.waitForTimeout(900);
  expect(draftPuts).toBe(0);

  // Enter app-level maximize, not the browser Fullscreen API.
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('primary-nav')).toHaveCount(0);
  await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-tabs')).toBeVisible();
  await expect(page.getByTestId('workflow-toolbar')).toBeVisible();
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await page.getByTestId('toggle-maximize').getAttribute('aria-label')).toBe(
    'Exit canvas maximize',
  );

  // The canvas expands and every editing-context value survives.
  await expect
    .poll(async () => (await page.getByTestId('workflow-canvas').boundingBox())?.width ?? 0)
    .toBeGreaterThan(canvasBefore!.width + 250);
  await expect(inputNode).toHaveAttribute('data-flow-x', String(flowBefore.x));
  await expect(inputNode).toHaveAttribute('data-flow-y', String(flowBefore.y));
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-viewport-x',
    String(viewportBefore.x),
  );
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-viewport-y',
    String(viewportBefore.y),
  );
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-zoom',
    String(viewportBefore.zoom),
  );
  await expect(inputNode).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('1 Edge');

  // Exit restores navigation, file explorer, panel proportions, and context.
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('primary-nav')).toBeVisible();
  await expect(page.getByTestId('explorer-panel')).toBeVisible();
  const explorerAfter = await page.getByTestId('explorer-panel').boundingBox();
  const agentAfter = await page.getByTestId('agent-panel').boundingBox();
  expect(Math.round(explorerAfter!.width)).toBe(Math.round(explorerBefore!.width));
  expect(Math.round(agentAfter!.width)).toBe(Math.round(agentBefore!.width));

  await expect(inputNode).toHaveAttribute('data-flow-x', String(flowBefore.x));
  await expect(inputNode).toHaveAttribute('data-flow-y', String(flowBefore.y));
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-zoom',
    String(viewportBefore.zoom),
  );
  await expect(inputNode).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('1 Edge');

  // Collapsed/expanded state is preserved rather than overwritten.
  await page.getByRole('button', { name: 'Collapse file explorer' }).click();
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse agent panel' }).click();
  await expect(page.getByTestId('agent-rail')).toBeVisible();

  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('explorer-panel')).toHaveCount(0);
  await expect(page.getByTestId('explorer-rail')).toHaveCount(0);
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await page.getByTestId('toggle-maximize').click();
  await expect(page.getByTestId('explorer-rail')).toBeVisible();
  await expect(page.getByTestId('agent-rail')).toBeVisible();
  await expect(page.getByTestId('explorer-panel')).toHaveCount(0);

  await page.waitForTimeout(900);
  expect(draftPuts).toBe(0);
  expect((await getDraft(page)).workflow).toEqual(workflowBefore);
});
