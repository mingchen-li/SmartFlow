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

interface RunBody {
  id: string;
  workflowId: string;
  status: string;
  snapshot: {
    version: number;
    workflow: {
      nodes: Array<{
        id: string;
        label: string;
        manifestId: string;
        parameters: Record<string, unknown>;
      }>;
      edges: Array<Record<string, unknown>>;
    };
    nodes: Array<{
      nodeId: string;
      manifestId: string;
      manifestVersion: string;
      parameters: Record<string, unknown>;
      fileReferences: Array<Record<string, unknown>>;
      resources: Record<string, unknown>;
      environment: Record<string, unknown>;
    }>;
  };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
}

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

async function draft(page: Page): Promise<{
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

async function listRuns(page: Page): Promise<RunBody[]> {
  const response = await page.request.get('/api/runs');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { runs: RunBody[] };
  return body.runs;
}

async function waitForNewRun(page: Page, previousIds: readonly string[]): Promise<RunBody> {
  let created: RunBody | undefined;
  await expect
    .poll(async () => {
      const runs = await listRuns(page);
      created = runs.find((run) => !previousIds.includes(run.id));
      return created !== undefined;
    }, { timeout: 10_000 })
    .toBe(true);
  return created!;
}

async function diagnosticCodes(page: Page): Promise<string[]> {
  return page
    .getByTestId('validation-diagnostic')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-code') ?? ''),
    );
}

test('validates a configured Binder Workflow, gates Run on validation, and freezes the Run snapshot', async ({
  page,
}) => {
  await insertNode(page, 'target-input');
  await insertNode(page, 'candidate-generation');
  await insertNode(page, 'candidate-comparison');

  const target = canvasNode(page, 'target-input');
  const generator = canvasNode(page, 'candidate-generation');
  const comparison = canvasNode(page, 'candidate-comparison');

  await connect(
    page,
    target.getByTestId('port-target-output'),
    generator.getByTestId('port-target-input'),
  );
  await connect(
    page,
    target.getByTestId('port-control-out-output'),
    generator.getByTestId('port-control-in-input'),
  );
  await connect(
    page,
    generator.getByTestId('port-candidates-output'),
    comparison.getByTestId('port-scored-input'),
  );
  await connect(
    page,
    generator.getByTestId('port-control-out-output'),
    comparison.getByTestId('port-control-in-input'),
  );
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('4 Edges');

  // Select a path-backed Project file, then configure the selected Nodes.
  await page.getByTestId('file-entry-inputs').click();
  await page.getByTestId('file-entry-inputs/candidates.fasta').click();
  await expect(page.getByTestId('explorer-selected-path')).toHaveText(
    'inputs/candidates.fasta',
  );

  await target.locator('.sflow-node-name').click();
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Target input');
  const targetFile = page.getByTestId('param-targetFile');
  await expect(targetFile.locator('option')).toHaveCount(2);
  await targetFile.selectOption({
    label: 'inputs/candidates.fasta',
  });
  await page.getByTestId('param-targetChain').selectOption('B');

  await generator.locator('.sflow-node-name').click();
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Candidate generation');
  await page.getByTestId('param-numCandidates').fill('250');

  // Before validation there is no current result: both Run controls are off.
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await expect(page.getByTestId('global-run')).toBeDisabled();

  await page.getByTestId('validate-workflow').click();
  await expect(page.getByTestId('validation-panel')).toBeVisible();
  await expect(page.getByTestId('validation-summary')).toHaveText('Workflow is valid.');
  await expect(page.getByTestId('run-workflow')).toBeEnabled();
  await expect(page.getByTestId('global-run')).toBeEnabled();

  // Layout-only state (selection) does not invalidate the Workflow result.
  await comparison.locator('.sflow-node-name').click();
  await expect(page.getByTestId('node-inspector-title')).toHaveText('Candidate comparison');
  await expect(page.getByTestId('run-workflow')).toBeEnabled();

  const runsBefore = await listRuns(page);
  const previousIds = runsBefore.map((run) => run.id);

  await page.getByTestId('run-workflow').click();
  await expect(page.getByTestId('toast')).toContainText('queued');
  await expect(page.getByTestId('monitor-run-state')).toHaveText('queued');

  const firstRun = await waitForNewRun(page, previousIds);
  expect(firstRun.status).toBe('queued');
  expect(firstRun.workflowId).toBe(DRAFT_ID);
  expect(Object.keys(firstRun.snapshot).sort()).toEqual(['nodes', 'version', 'workflow']);
  expect(firstRun.snapshot.workflow.nodes).toHaveLength(3);

  const targetSnapshot = firstRun.snapshot.nodes.find(
    (node) => node.manifestId === 'target-input',
  )!;
  expect(targetSnapshot.parameters).toMatchObject({
    targetChain: 'B',
    targetFile: { path: 'inputs/candidates.fasta' },
  });
  expect(targetSnapshot.fileReferences).toEqual([
    expect.objectContaining({
      parameterId: 'targetFile',
      path: 'inputs/candidates.fasta',
    }),
  ]);

  const generatorSnapshot = firstRun.snapshot.nodes.find(
    (node) => node.manifestId === 'candidate-generation',
  )!;
  expect(generatorSnapshot.parameters.numCandidates).toBe(250);
  expect(generatorSnapshot.manifestVersion).toBe('1.0.0');
  expect(generatorSnapshot.resources).toMatchObject({ cpu: 4, memory: '8Gi' });
  expect(generatorSnapshot.environment).toMatchObject({
    image: 'ghcr.io/sflow/nodes/candidate-generation:1.0.0',
  });

  // The snapshot excludes every kind of editor presentation state.
  const serialized = JSON.stringify(firstRun.snapshot);
  for (const uiState of [
    'positions',
    'viewport',
    'selection',
    'panelWidths',
    'collapsed',
    'maximize',
    'libraryQuery',
    'libraryCategory',
    'agentGeometry',
  ]) {
    expect(serialized).not.toContain(uiState);
  }

  // Editing the draft makes the validation result stale and disables Run.
  await generator.locator('.sflow-node-name').click();
  await page.getByTestId('param-numCandidates').fill('999');
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await expect(page.getByTestId('global-run')).toBeDisabled();
  await expect(page.getByTestId('validation-stale')).toBeVisible();

  await page.getByTestId('validate-workflow').click();
  await expect(page.getByTestId('validation-summary')).toHaveText('Workflow is valid.');
  await expect(page.getByTestId('run-workflow')).toBeEnabled();

  const secondPreviousIds = (await listRuns(page)).map((run) => run.id);
  await page.getByTestId('run-workflow').click();
  const secondRun = await waitForNewRun(page, secondPreviousIds);
  expect(secondRun.id).not.toBe(firstRun.id);
  expect(
    secondRun.snapshot.nodes.find(
      (node) => node.manifestId === 'candidate-generation',
    )?.parameters.numCandidates,
  ).toBe(999);

  // The first Run still describes the draft it started from.
  const storedFirst = (await listRuns(page)).find((run) => run.id === firstRun.id)!;
  expect(storedFirst).toEqual(firstRun);
});

test('shows validation diagnostics per Node and connection and rejects Runs before validation passes', async ({
  page,
}) => {
  await insertNode(page, 'target-input');
  await insertNode(page, 'candidate-generation');

  const target = canvasNode(page, 'target-input');
  const generator = canvasNode(page, 'candidate-generation');

  // A data edge without the required control input and without a File Reference.
  await connect(
    page,
    target.getByTestId('port-target-output'),
    generator.getByTestId('port-target-input'),
  );
  await expect(page.getByTestId('canvas-edge-count')).toHaveText('1 Edge');

  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await page.getByTestId('validate-workflow').click();

  await expect(page.getByTestId('validation-panel')).toBeVisible();
  await expect(page.getByTestId('validation-summary')).toContainText('validation error');
  const codes = await diagnosticCodes(page);
  expect(codes).toEqual(
    expect.arrayContaining(['MISSING_INPUT', 'PARAMETER_ERROR', 'MISSING_BINDER_OUTPUT']),
  );

  const missingInput = page.locator(
    '[data-testid="validation-diagnostic"][data-code="MISSING_INPUT"]',
  );
  await expect(missingInput).toHaveCount(1);
  await expect(missingInput.getByTestId('validation-location')).toContainText(
    'Candidate generation',
  );
  await expect(missingInput.getByTestId('validation-correction')).toContainText('control-in');

  const missingFile = page.locator(
    '[data-testid="validation-diagnostic"][data-code="PARAMETER_ERROR"]',
  );
  await expect(missingFile.getByTestId('validation-location')).toContainText('Target input');
  await expect(missingFile.getByTestId('validation-correction')).toContainText('targetFile');

  await expect(page.getByTestId('run-workflow')).toBeDisabled();
  await expect(page.getByTestId('global-run')).toBeDisabled();

  // The Run API rejects the same draft even when the disabled button is bypassed.
  const rejected = await page.request.post(`/api/workflows/${DRAFT_ID}/runs`, {
    data: {},
  });
  expect(rejected.status()).toBe(422);
  const body = (await rejected.json()) as {
    error: { code: string; details: { diagnostics: Array<Record<string, unknown>> } };
  };
  expect(body.error.code).toBe('VALIDATION_FAILED');
  expect(body.error.details.diagnostics.length).toBeGreaterThan(0);

  // A connection that violates the Manifest contract is reported by connection.
  const current = await draft(page);
  const edges = current.workflow.edges as Array<Record<string, unknown>>;
  edges[0] = { ...edges[0], sourcePort: 'control-out' };
  const saved = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: current.name, workflow: current.workflow, layout: current.layout },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');

  await page.getByTestId('validate-workflow').click();
  const invalidConnection = page.locator(
    '[data-testid="validation-diagnostic"][data-code="INVALID_CONNECTION"]',
  );
  await expect(invalidConnection).toHaveCount(1);
  await expect(invalidConnection.getByTestId('validation-location')).toContainText(
    'Connection',
  );
  await expect(invalidConnection.getByTestId('validation-correction')).toContainText(
    'same kind',
  );
  await expect(page.getByTestId('run-workflow')).toBeDisabled();
});
