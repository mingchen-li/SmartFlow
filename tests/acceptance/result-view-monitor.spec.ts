import { statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';
const DRAFT_ID = 'binder-design';

const NODE_IDS = {
  target: 'node-target',
  generator: 'node-generator',
  comparison: 'node-comparison',
};

const LAYOUT = {
  version: 1,
  positions: {
    [NODE_IDS.target]: { x: 40, y: 80 },
    [NODE_IDS.generator]: { x: 320, y: 80 },
    [NODE_IDS.comparison]: { x: 600, y: 80 },
  },
  viewport: { x: 0, y: 0, zoom: 0.8 },
  selection: { nodeId: null, edgeId: null },
};

interface TestRun {
  id: string;
  status: string;
}

interface TestArtifact {
  id: string;
  name: string;
  mediaType: string;
  path: string;
  size: number;
  sha256: string;
  schema?: { namespace: string; name: string; version: string };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Project credential').fill(PASSWORD);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('global-toolbar')).toBeVisible();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
}

/**
 * Saves the three-Node Binder Workflow through the Project API. The target
 * input is the seeded FASTA so the deterministic Nodes run without fixtures.
 */
async function saveBinderWorkflow(page: Page): Promise<void> {
  const referenceResponse = await page.request.post('/api/files', {
    data: { path: 'inputs/candidates.fasta' },
  });
  expect(referenceResponse.ok()).toBe(true);
  const reference = (await referenceResponse.json()) as {
    id: string;
    path: string;
    name: string;
  };

  const workflow = {
    version: 1,
    id: DRAFT_ID,
    name: 'Binder design',
    nodes: [
      {
        id: NODE_IDS.target,
        manifestId: 'target-input',
        manifestVersion: '1.0.0',
        label: 'Target input',
        parameters: {
          targetFile: {
            fileReferenceId: reference.id,
            path: reference.path,
            name: reference.name,
          },
          targetChain: 'A',
        },
        resources: {},
      },
      {
        id: NODE_IDS.generator,
        manifestId: 'candidate-generation',
        manifestVersion: '1.0.0',
        label: 'Candidate generation',
        parameters: { numCandidates: 4, seed: 42 },
        resources: {},
      },
      {
        id: NODE_IDS.comparison,
        manifestId: 'candidate-comparison',
        manifestVersion: '1.0.0',
        label: 'Candidate comparison',
        parameters: {
          topN: 2,
          rankingMetric: 'plddt',
          deduplicate: true,
          label: 'round-1',
        },
        resources: {},
      },
    ],
    edges: [
      {
        id: 'e-target-data',
        source: NODE_IDS.target,
        sourcePort: 'target',
        target: NODE_IDS.generator,
        targetPort: 'target',
      },
      {
        id: 'e-target-control',
        source: NODE_IDS.target,
        sourcePort: 'control-out',
        target: NODE_IDS.generator,
        targetPort: 'control-in',
      },
      {
        id: 'e-generator-data',
        source: NODE_IDS.generator,
        sourcePort: 'candidates',
        target: NODE_IDS.comparison,
        targetPort: 'scored',
      },
      {
        id: 'e-generator-control',
        source: NODE_IDS.generator,
        sourcePort: 'control-out',
        target: NODE_IDS.comparison,
        targetPort: 'control-in',
      },
    ],
  };

  const saved = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: 'Binder design', workflow, layout: LAYOUT },
  });
  expect(saved.ok()).toBe(true);
}

async function startRun(page: Page): Promise<TestRun> {
  const response = await page.request.post(`/api/workflows/${DRAFT_ID}/runs`, { data: {} });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { run: TestRun }).run;
}

async function openCompletedRun(page: Page): Promise<TestRun> {
  await saveBinderWorkflow(page);
  const run = await startRun(page);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByTestId('monitor-run-state')).toHaveText('completed', {
    timeout: 15_000,
  });
  return run;
}

async function resultViewBody(
  page: Page,
  runId: string,
): Promise<{
  resultView: { blocks: Array<Record<string, unknown>> };
  data: { artifacts: TestArtifact[] };
}> {
  const response = await page.request.get(`/api/runs/${runId}/result-view`);
  expect(response.ok()).toBe(true);
  return response.json();
}

/** Serves long deterministic Task logs so scroll containment can be asserted. */
async function serveLongTaskLogs(page: Page): Promise<void> {
  await page.route('**/api/runs/*/tasks/*/logs', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      runId: string;
      taskId: string;
      available: boolean;
      logsPath?: string;
    };
    const lines = Array.from(
      { length: 120 },
      (_, index) => `log line ${String(index + 1).padStart(3, '0')} for ${body.taskId}`,
    );
    await route.fulfill({
      response,
      json: {
        runId: body.runId,
        taskId: body.taskId,
        available: body.available,
        ...(body.logsPath ? { logsPath: body.logsPath } : {}),
        lines,
      },
    });
  });
}

function monitorTab(page: Page, id: string) {
  return page.getByTestId(`monitor-tab-${id}`);
}

test('monitor exposes five live tabs with independent, scrollable panels inside the viewport', async ({
  page,
}) => {
  await signIn(page);
  await serveLongTaskLogs(page);
  await openCompletedRun(page);

  // Five tabs, all named and switchable.
  for (const [id, label] of [
    ['overview', 'Overview'],
    ['tasks', 'Tasks / Slurm'],
    ['resources', 'Resources'],
    ['logs', 'Logs'],
    ['results', 'Results'],
  ] as const) {
    await expect(monitorTab(page, id)).toHaveText(label);
  }

  // Overview is the default and keeps three monitor cards.
  await expect(page.getByTestId('monitor-panel-overview')).toBeVisible();
  await expect(page.getByTestId('monitor-cards').locator('.card')).toHaveCount(3);
  await expect(page.getByTestId('monitor-run-state')).toHaveText('completed');
  await expect(page.getByTestId('monitor-progress')).toContainText('3 / 3');

  // Tasks / Slurm renders each Task's state, attempt, and scheduler identity.
  await monitorTab(page, 'tasks').click();
  await expect(page.getByTestId('monitor-panel-tasks')).toBeVisible();
  await expect(page.getByTestId('monitor-panel-overview')).toHaveCount(0);
  await expect(page.getByTestId('monitor-tasks').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByTestId('monitor-tasks')).toContainText('Local');
  const taskStates = page.locator('[data-testid^="monitor-task-state-"]');
  await expect(taskStates).toHaveCount(3);
  for (const state of await taskStates.all()) {
    await expect(state).toHaveText('completed');
  }

  // Resources shows the snapshot requirements and current usage.
  await monitorTab(page, 'resources').click();
  await expect(page.getByTestId('monitor-panel-resources')).toBeVisible();
  await expect(page.getByTestId('monitor-resource-requirements').locator('tbody tr')).toHaveCount(
    3,
  );
  await expect(page.getByTestId('monitor-resource-usage')).toContainText('0 running');
  await expect(page.getByTestId('monitor-resource-requirements')).toContainText('8Gi');

  // Logs owns one scroll pane for Run events and one per Task. Scrolling one
  // pane never moves another.
  await monitorTab(page, 'logs').click();
  await expect(page.getByTestId('monitor-panel-logs')).toBeVisible();
  await expect(page.getByTestId('monitor-events-log')).toBeVisible();
  const logPanes = page.locator('[data-testid="monitor-panel-logs"] .log-pane');
  expect(await logPanes.count()).toBe(4);
  for (const pane of await logPanes.all()) {
    await expect(pane).toHaveCSS('overflow-y', 'auto');
  }
  const firstPane = logPanes.nth(1);
  const otherPane = logPanes.nth(2);
  const overflow = await firstPane.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  await firstPane.evaluate((element) => {
    element.scrollTop = 80;
  });
  expect(await firstPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await otherPane.evaluate((element) => element.scrollTop)).toBe(0);

  // Results previews outputs and opens the full Result View.
  await monitorTab(page, 'results').click();
  await expect(page.getByTestId('monitor-panel-results')).toBeVisible();
  await expect(page.getByTestId('monitor-results-artifacts')).toContainText('candidates.json');
  await expect(page.getByTestId('monitor-results-metrics')).toContainText('Best pLDDT');
  await expect(page.getByTestId('open-result-view')).toBeEnabled();

  // At a narrow width every tab survives; panels stack or scroll instead of
  // dropping content, and the document itself never scrolls.
  await page.setViewportSize({ width: 700, height: 640 });
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  await expect(monitorTab(page, 'logs')).toBeVisible();
  await monitorTab(page, 'overview').click();
  await expect(page.getByTestId('monitor-cards').locator('.card')).toHaveCount(3);
  await monitorTab(page, 'logs').click();
  await expect(page.getByTestId('monitor-panel-logs')).toBeVisible();
  await expect(page.getByTestId('monitor-events-log')).toBeVisible();
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.innerHeight + 1);
});

test('shows read-only active Run and Task state on canvas Nodes without mutating the draft', async ({
  page,
}) => {
  await signIn(page);
  await saveBinderWorkflow(page);
  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');

  // Keep the Run observably active: detail reads report it as running even
  // after the deterministic executor has already finished.
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

  const generator = page.locator(
    `[data-testid="canvas-node"][data-manifest-id="candidate-generation"]`,
  );
  await generator.locator('.sflow-node-name').click();
  await expect(generator).toHaveAttribute('data-selected', 'true');
  const positionsBefore = await page.locator('[data-testid="canvas-node"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-node-id'),
      x: node.getAttribute('data-flow-x'),
      y: node.getAttribute('data-flow-y'),
      selected: node.getAttribute('data-selected'),
    })),
  );

  await page.getByTestId('validate-workflow').click();
  await expect(page.getByTestId('validation-summary')).toHaveText('Workflow is valid.');
  // Validation persisted the draft (including the intentional selection), so
  // this snapshot isolates any change caused by the live Run overlay.
  const draftBefore = await (await page.request.get(`/api/workflows/${DRAFT_ID}`)).json();
  await page.getByTestId('run-workflow').click();

  // The monitor and every Node show the active state; the overlay is read-only.
  await expect(page.getByTestId('monitor-run-state')).toHaveText('running', {
    timeout: 10_000,
  });
  await expect(page.locator('[data-testid="node-runtime-state"]').first()).toHaveText('running');
  await expect(page.locator('[data-testid="node-runtime-state"]')).toHaveCount(3);
  const runtime = page.locator('[data-testid="node-runtime-state"]').first();
  await expect(runtime).toHaveAttribute('data-readonly', 'true');

  const positionsAfter = await page.locator('[data-testid="canvas-node"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-node-id'),
      x: node.getAttribute('data-flow-x'),
      y: node.getAttribute('data-flow-y'),
      selected: node.getAttribute('data-selected'),
    })),
  );
  expect(positionsAfter).toEqual(positionsBefore);
  await expect(page.getByTestId('canvas-selection')).toHaveText('Selected: Candidate generation');

  const draftAfter = await (await page.request.get(`/api/workflows/${DRAFT_ID}`)).json();
  expect(draftAfter.workflow).toEqual(draftBefore.workflow);
  expect(draftAfter.layout).toEqual(draftBefore.layout);

  // Once the Run is no longer active the overlay disappears.
  await page.unroute('**/api/runs/*');
  await expect(page.getByTestId('monitor-run-state')).toHaveText('completed', {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="node-runtime-state"]')).toHaveCount(0);
});

test('inspects Results, renders compatible scientific blocks, and downloads output files', async ({
  page,
}) => {
  await signIn(page);
  const run = await openCompletedRun(page);
  const body = await resultViewBody(page, run.id);
  const artifact = (name: string): TestArtifact => {
    const found = body.data.artifacts.find((candidate) => candidate.name === name);
    expect(found, `Missing Artifact ${name}`).toBeDefined();
    return found!;
  };

  await monitorTab(page, 'results').click();
  await page.getByTestId('open-result-view').click();
  const surface = page.getByTestId('result-view-surface');
  await expect(surface).toBeVisible();
  await expect(page.getByTestId('result-view-run-status')).toHaveText('completed');

  // Logs and output files lead the page.
  await expect(page.getByTestId('result-view-block-logs')).toBeVisible();
  await expect(page.getByTestId('result-view-block-artifacts')).toBeVisible();
  const blockOrder = await page
    .locator('[data-testid^="result-view-block-"]')
    .evaluateAll((blocks) => blocks.map((block) => block.getAttribute('data-testid')));
  expect(blockOrder.indexOf('result-view-block-logs')).toBeLessThan(
    blockOrder.indexOf('result-view-block-artifacts'),
  );
  expect(blockOrder.indexOf('result-view-block-artifacts')).toBeLessThan(
    blockOrder.indexOf('result-view-block-candidates'),
  );

  // Run events and Task logs each own an independently scrollable pane.
  await expect(page.getByTestId('result-view-events-log')).toBeVisible();
  const taskLogPanes = page.locator('[data-testid^="result-view-task-log-"]');
  await expect(taskLogPanes).toHaveCount(3);

  // CandidateSets render through the compatible schema-bound blocks.
  await expect(page.getByTestId('result-view-block-candidates')).toContainText(
    'Generated candidates',
  );
  await expect(page.locator('[data-testid^="candidate-row-"]').first()).toBeVisible();
  await expect(page.getByTestId('result-view-block-candidates')).toContainText('candidate-0001');

  // Metrics keep their namespaced meanings.
  await expect(page.getByTestId('result-view-block-metrics')).toContainText('Best pLDDT');
  await expect(page.getByTestId('result-view-block-metrics')).toContainText(
    'sflow.binder.candidate-comparison/bestPlddt@1.0.0',
  );

  // Provenance links outputs back to their Task attempts.
  await expect(page.getByTestId('result-view-block-provenance')).toContainText(
    'candidate-generation',
  );

  // Registered Widgets render only compatible data; the structure viewer has
  // no predicted structures and shows an explicit empty state.
  await expect(page.getByTestId('result-view-widget-sflow.candidate-table')).toBeVisible();
  await expect(page.getByTestId('result-view-widget-sflow.metric-summary')).toBeVisible();
  await expect(page.getByTestId('widget-empty-sflow.structure-viewer')).toBeVisible();

  // Every output file has its own immutable download.
  await expect(
    page.locator('[data-testid="result-view-block-artifacts"] [data-testid^="artifact-download-"]'),
  ).toHaveCount(5);
  const jsonArtifact = artifact('candidates.json');
  const downloadLink = page.getByTestId(`artifact-download-${jsonArtifact.id}`);
  await expect(downloadLink).toHaveAttribute('download', 'candidates.json');
  await expect(downloadLink).toHaveAttribute(
    'href',
    `/api/runs/${run.id}/artifacts/${jsonArtifact.id}/download`,
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ]);
  expect(download.suggestedFilename()).toBe('candidates.json');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(statSync(downloadedPath!).size).toBe(jsonArtifact.size);

  // The overlay contains its own scrolling; the document stays fixed.
  const overflow = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(overflow.bodyOverflow).toBe('hidden');
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.innerHeight + 1);

  await page.getByTestId('result-view-close').click();
  await expect(surface).toHaveCount(0);

  // The Runs section opens the same durable Result View.
  await page.getByTestId('nav-runs').click();
  await expect(page.getByTestId('runs-list')).toBeVisible();
  await page.getByTestId(`open-run-result-view-${run.id}`).click();
  await expect(page.getByTestId('result-view-surface')).toBeVisible();
  await expect(page.getByTestId('result-view-block-logs')).toBeVisible();
  await page.getByTestId('result-view-close').click();
  await expect(surface).toHaveCount(0);
});

test('omits incompatible Widget bindings with a reason and falls back for unknown outputs', async ({
  page,
}) => {
  await signIn(page);
  const run = await openCompletedRun(page);
  const body = await resultViewBody(page, run.id);
  const baseArtifact = body.data.artifacts[0]!;

  await page.route('**/api/runs/*/result-view', async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      resultView: { blocks: Array<Record<string, unknown>> };
      data: { artifacts: TestArtifact[] };
    } & Record<string, unknown>;
    payload.resultView.blocks.push({
      id: 'widget-incompatible',
      kind: 'widget',
      title: 'Incompatible widget',
      widgetId: 'sflow.structure-viewer',
      binding: {
        metricSchemas: [{ namespace: 'sflow.binder', name: 'candidate-set', version: '1.0.0' }],
      },
    });
    payload.data.artifacts.push({
      ...baseArtifact,
      id: 'artifact-unknown',
      name: 'mystery-output.bin',
      mediaType: 'application/octet-stream',
      path: baseArtifact.path.replace(/[^/]+$/, 'mystery-output.bin'),
      sha256: '0'.repeat(64),
      size: 1234,
    });
    delete payload.data.artifacts[payload.data.artifacts.length - 1]!.schema;
    await route.fulfill({ response, json: payload });
  });

  await monitorTab(page, 'results').click();
  await page.getByTestId('open-result-view').click();
  await expect(page.getByTestId('result-view-surface')).toBeVisible();

  // The incompatible Widget block is omitted and its reason is visible; the
  // compatible Widget remains rendered. No data is coerced into it.
  const rejection = page.getByTestId('result-view-rejection-widget-incompatible');
  await expect(rejection).toBeVisible();
  await expect(rejection).toContainText('does not accept binding schema');
  await expect(page.getByTestId('result-view-block-widget-incompatible')).toHaveCount(0);
  await expect(page.getByTestId('result-view-widget-sflow.candidate-table')).toBeVisible();

  // An output without a known schema renders through the safe generic view:
  // filename, media type, size, download, and raw metadata only.
  const generic = page.getByTestId('generic-output-artifact-unknown');
  await expect(generic).toBeVisible();
  await expect(generic).toContainText('mystery-output.bin');
  await expect(generic).toContainText('application/octet-stream');
  await expect(generic).toContainText('1234 bytes');
  await expect(page.getByTestId('artifact-download-artifact-unknown')).toBeVisible();
  const metadata = page.getByTestId('artifact-metadata-artifact-unknown');
  await expect(metadata).toBeVisible();
  await expect(metadata).toContainText('"mystery-output.bin"');
  await expect(metadata).toContainText('0'.repeat(64));

  // The unknown output did not leak into the CandidateSet widget.
  await expect(page.getByTestId('result-view-widget-sflow.candidate-table')).not.toContainText(
    'mystery-output.bin',
  );
});
