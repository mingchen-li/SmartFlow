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

const ZOOM = 0.86;

const NODE_IDS = {
  target: 'node-target',
  generator: 'node-generator',
  designer: 'node-designer',
  predictor: 'node-predictor',
  comparison: 'node-comparison',
};

const LAYOUT = {
  version: 1,
  positions: {
    [NODE_IDS.target]: { x: 40, y: 40 },
    [NODE_IDS.generator]: { x: 280, y: 40 },
    [NODE_IDS.designer]: { x: 520, y: 40 },
    [NODE_IDS.predictor]: { x: 40, y: 220 },
    [NODE_IDS.comparison]: { x: 280, y: 220 },
  },
  viewport: { x: 0, y: 0, zoom: ZOOM },
  selection: { nodeId: null, edgeId: null },
};

/**
 * The standard Binder DAG. The target file is intentionally left unset here:
 * this acceptance path selects it through the Project explorer and the Node
 * Inspector, exactly as a user would.
 */
function buildBinderWorkflow() {
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
      node(NODE_IDS.target, 'target-input', 'Target input', {
        targetChain: 'A',
        hotspotResidues: '',
      }),
      node(NODE_IDS.generator, 'candidate-generation', 'Candidate generation', {
        numCandidates: 5,
        seed: 42,
        strategy: 'random',
        useTargetHotspots: true,
        designNote: '',
      }),
      node(NODE_IDS.designer, 'sequence-design', 'Sequence design', {
        model: 'vhh-designer-v1',
        temperature: 0.7,
        numDesigns: 3,
        randomSeed: 7,
        trimTerminalTags: true,
      }),
      node(NODE_IDS.predictor, 'structure-prediction', 'Structure prediction', {
        predictor: 'esmfold2',
        recycles: 3,
        batchSize: 4,
        seed: 1,
      }),
      node(NODE_IDS.comparison, 'candidate-comparison', 'Candidate comparison', {
        topN: 2,
        rankingMetric: 'plddt',
        deduplicate: true,
        label: 'round-1',
      }),
    ],
    edges: [
      edge('e-target-data', NODE_IDS.target, 'target', NODE_IDS.generator, 'target'),
      edge(
        'e-target-control',
        NODE_IDS.target,
        'control-out',
        NODE_IDS.generator,
        'control-in',
      ),
      edge(
        'e-generator-data',
        NODE_IDS.generator,
        'candidates',
        NODE_IDS.designer,
        'candidates',
      ),
      edge(
        'e-generator-control',
        NODE_IDS.generator,
        'control-out',
        NODE_IDS.designer,
        'control-in',
      ),
      edge('e-designer-data', NODE_IDS.designer, 'designs', NODE_IDS.predictor, 'designs'),
      edge(
        'e-designer-control',
        NODE_IDS.designer,
        'control-out',
        NODE_IDS.predictor,
        'control-in',
      ),
      edge('e-predictor-data', NODE_IDS.predictor, 'scored', NODE_IDS.comparison, 'scored'),
      edge(
        'e-predictor-control',
        NODE_IDS.predictor,
        'control-out',
        NODE_IDS.comparison,
        'control-in',
      ),
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

async function saveWorkflow(page: Page, workflow: unknown, layout: unknown): Promise<void> {
  const response = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: 'Binder design', workflow, layout },
  });
  expect(response.ok()).toBe(true);
}

async function resetDraft(page: Page): Promise<void> {
  await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: 'Binder design', workflow: EMPTY_WORKFLOW, layout: EMPTY_LAYOUT },
  });
}

async function getDraft(page: Page): Promise<{
  workflow: {
    nodes: Array<{ id: string; parameters: Record<string, unknown> }>;
    edges: Array<Record<string, unknown>>;
  };
  layout: Record<string, unknown>;
}> {
  const response = await page.request.get(`/api/workflows/${DRAFT_ID}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

function canvasNode(page: Page, manifestId: string): Locator {
  return page.locator(`[data-testid="canvas-node"][data-manifest-id="${manifestId}"]`);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await resetDraft(page);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
});

// The Project Server is shared by the whole worker; leave it empty for the
// specs that follow.
test.afterEach(async ({ page }) => {
  await resetDraft(page);
});

test('runs the standard Binder DAG end to end from file selection through Result View inspection', async ({
  page,
}) => {
  // The workspace is a fixed viewport: the document never scrolls.
  const initialViewport = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(initialViewport.bodyOverflow).toBe('hidden');
  expect(initialViewport.scrollWidth).toBeLessThanOrEqual(initialViewport.innerWidth + 1);
  expect(initialViewport.scrollHeight).toBeLessThanOrEqual(initialViewport.innerHeight + 1);
  await expect(page.getByTestId('brand')).toHaveText('SFlow');

  // Select a Project file: this creates the path-backed File Reference that
  // the Target input will consume.
  await page.getByTestId('file-entry-inputs').click();
  await page.getByTestId('file-entry-inputs/candidates.fasta').click();
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/files/references');
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as { references: unknown[] };
      return body.references.length;
    })
    .toBeGreaterThanOrEqual(1);

  // The Node Library is categorized and searchable; insertion creates a
  // configured Node instance and selects it.
  await page.getByTestId('nav-node-library').click();
  const library = page.getByTestId('node-library');
  await expect(library).toBeVisible();
  await expect(page.getByTestId('node-library-search')).toBeFocused();
  await expect(page.getByTestId('node-library-count-protein-design')).toHaveText('2');
  await page.getByTestId('node-library-category-protein-design').click();
  await page.getByTestId('node-library-search').fill('VHH');
  await expect(page.getByTestId('node-library-result-count')).toHaveText('1 Node');
  await page.getByTestId('node-library-node-sequence-design').click();
  await expect(library).toHaveCount(0);
  await expect(canvasNode(page, 'sequence-design')).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Sequence design');

  // Duplicating creates a second instance of the same Manifest, selects the
  // copy, and activates the Node Agent for that selection.
  await page.getByTestId('duplicate-node').click();
  await expect(canvasNode(page, 'sequence-design')).toHaveCount(2);
  await expect(canvasNode(page, 'sequence-design').nth(1)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(page.getByTestId('node-inspector-title')).toHaveText(
    'Sequence design copy',
  );
  await expect(page.getByTestId('agent-mode-indicator')).toHaveText('Node Agent');
  await expect(page.getByTestId('agent-context-card')).toContainText(
    'Sequence design copy',
  );

  // Wait for the UI edits to be autosaved before replacing the scratch canvas
  // with the complete standard Binder draft.
  await expect
    .poll(async () => {
      const draft = await getDraft(page);
      return draft.workflow.nodes.length;
    })
    .toBe(2);
  await saveWorkflow(page, buildBinderWorkflow(), LAYOUT);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await expect(page.getByTestId('canvas-node-count')).toHaveText('5 Nodes');
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('8 Edges');
  for (const manifestId of [
    'target-input',
    'candidate-generation',
    'sequence-design',
    'structure-prediction',
    'candidate-comparison',
  ]) {
    await expect(canvasNode(page, manifestId)).toHaveCount(1);
  }

  // Configure the Target input with the Project file selected above, through
  // the Node Inspector.
  await canvasNode(page, 'target-input').locator('.sflow-node-name').click();
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  const targetFile = page.getByTestId('param-targetFile');
  await expect(targetFile.locator('option')).toHaveCount(2);
  await targetFile.selectOption({ label: 'inputs/candidates.fasta' });
  await expect(targetFile.locator('option:checked')).toHaveText(
    'inputs/candidates.fasta',
  );
  await expect(page.getByTestId('inspector-validation')).toContainText(
    'All parameters are valid',
  );

  // Validation runs the shared Workflow contract, including required Binder
  // outputs, and only then enables Run.
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await page.getByTestId('validate-workflow').click();
  await expect(page.getByTestId('validation-summary')).toHaveText(
    'Workflow is valid.',
  );
  await expect(page.getByTestId('run-workflow')).toBeEnabled();
  await expect(page.getByTestId('global-run')).toBeEnabled();

  const beforeRun = await getDraft(page);

  // Hold the Run in an observably active state so the read-only canvas
  // overlay can be inspected before the deterministic executor finishes.
  await page.route('**/api/runs/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/api\/runs\/[^/]+$/.test(pathname)) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      run: { status: string };
      tasks: Array<{ state: string }>;
    };
    body.run.status = 'running';
    body.tasks = body.tasks.map((task) => ({ ...task, state: 'running' }));
    await route.fulfill({ response, json: body });
  });

  await page.getByTestId('run-workflow').click();
  await expect(page.getByTestId('monitor-run-state')).toHaveText('running', {
    timeout: 10_000,
  });

  // Every Node exposes read-only active Task state, and the overlay never
  // mutates Workflow IR or layout.
  const runtimeStates = page.locator('[data-testid="node-runtime-state"]');
  await expect(runtimeStates).toHaveCount(5);
  for (const state of await runtimeStates.all()) {
    await expect(state).toHaveText('running');
    await expect(state).toHaveAttribute('data-readonly', 'true');
  }
  const duringRun = await getDraft(page);
  expect(duringRun.workflow).toEqual(beforeRun.workflow);
  expect(duringRun.layout).toEqual(beforeRun.layout);
  await expect(page.getByTestId('monitor-progress')).toContainText('0 / 5');

  // Release the deterministic Run and observe its real completion.
  await page.unroute('**/api/runs/*');
  await expect(page.getByTestId('monitor-run-state')).toHaveText('completed', {
    timeout: 15_000,
  });
  await expect(runtimeStates).toHaveCount(0);
  await expect(page.getByTestId('monitor-progress')).toContainText('5 / 5');

  // Run monitoring covers all five ordered Tasks, each attempt, scheduler,
  // and logs.
  await page.getByTestId('monitor-tab-tasks').click();
  await expect(page.getByTestId('monitor-tasks').locator('tbody tr')).toHaveCount(5);
  await expect(page.getByTestId('monitor-tasks')).toContainText('Local');
  const taskStates = page.locator('[data-testid^="monitor-task-state-"]');
  await expect(taskStates).toHaveCount(5);
  for (const state of await taskStates.all()) {
    await expect(state).toHaveText('completed');
  }
  expect(
    await page
      .getByTestId('monitor-tasks')
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid'))),
  ).toHaveLength(5);

  await page.getByTestId('monitor-tab-logs').click();
  await expect(page.getByTestId('monitor-events-log')).toBeVisible();
  await expect(page.locator('[data-testid="monitor-panel-logs"] .log-pane')).toHaveCount(6);
  await expect(page.getByTestId('monitor-panel-logs')).toContainText(
    'node=target-input attempt=1',
  );

  await page.getByTestId('monitor-tab-results').click();
  await expect(page.getByTestId('monitor-results-artifacts')).toContainText(
    'design-0003.pdb',
  );
  await expect(page.getByTestId('monitor-results-artifacts')).toContainText(
    'report.json',
  );
  await expect(page.getByTestId('open-result-view')).toBeEnabled();

  // Result View inspection resolves the complete path: five Task logs, all
  // twelve outputs, the four chained CandidateSets, typed Metrics, Provenance,
  // and a structure viewer with all predicted designs.
  await page.getByTestId('open-result-view').click();
  const surface = page.getByTestId('result-view-surface');
  await expect(surface).toBeVisible();
  await expect(page.getByTestId('result-view-run-status')).toHaveText('completed');
  await expect(page.locator('[data-testid^="result-view-rejection-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="result-view-task-log-"]')).toHaveCount(5);
  await expect(page.getByTestId('result-view-block-logs')).toContainText(
    'node=target-input attempt=1',
  );

  const artifactBlock = page.getByTestId('result-view-block-artifacts');
  for (const name of [
    'target.json',
    'candidates.json',
    'designs.json',
    'scored.json',
    'ranking.json',
    'report.json',
    'design-0001.pdb',
    'design-0002.pdb',
    'design-0003.pdb',
  ]) {
    await expect(artifactBlock).toContainText(name);
  }
  await expect(
    artifactBlock.locator('[data-testid^="artifact-download-"]'),
  ).toHaveCount(12);

  const candidateBlock = page.getByTestId('result-view-block-candidates');
  await expect(candidateBlock.locator('[data-testid^="candidate-set-"]')).toHaveCount(
    4,
  );
  await expect(candidateBlock.locator('[data-testid^="candidate-row-"]')).toHaveCount(
    13,
  );
  for (const strategy of [
    'random',
    'vhh-designer-v1',
    'structure-prediction',
    'candidate-comparison',
  ]) {
    await expect(candidateBlock).toContainText(strategy);
  }
  await expect(candidateBlock).toContainText('candidate-0001');

  await expect(page.getByTestId('result-view-block-metrics')).toContainText(
    'Mean pLDDT',
  );
  await expect(page.getByTestId('result-view-block-metrics')).toContainText(
    'sflow.binder.structure-prediction/meanPlddt@1.0.0',
  );
  await expect(page.getByTestId('result-view-block-metrics')).toContainText(
    'Best pLDDT',
  );
  await expect(page.getByTestId('result-view-block-provenance')).toContainText(
    'structure-prediction',
  );
  await expect(page.getByTestId('result-view-block-provenance')).toContainText(
    'candidate-comparison',
  );

  const structureWidget = page.getByTestId('result-view-widget-sflow.structure-viewer');
  await expect(structureWidget).toBeVisible();
  await expect(
    page.getByTestId('widget-empty-sflow.structure-viewer'),
  ).toHaveCount(0);
  const structureArtifacts = structureWidget.locator(
    '[data-testid^="structure-artifact-"]',
  );
  await expect(structureArtifacts).toHaveCount(3);
  for (const name of ['design-0001.pdb', 'design-0002.pdb', 'design-0003.pdb']) {
    await expect(structureWidget).toContainText(name);
  }
  await expect(page.getByTestId('result-view-widget-sflow.candidate-table')).toBeVisible();
  await expect(page.getByTestId('result-view-widget-sflow.metric-summary')).toBeVisible();

  const resultViewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(resultViewport.scrollWidth).toBeLessThanOrEqual(
    resultViewport.innerWidth + 1,
  );
  expect(resultViewport.scrollHeight).toBeLessThanOrEqual(
    resultViewport.innerHeight + 1,
  );

  await page.getByTestId('result-view-close').click();
  await expect(surface).toHaveCount(0);
});
