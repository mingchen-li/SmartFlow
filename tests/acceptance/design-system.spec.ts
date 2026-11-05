import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'e2e-password';
const DRAFT_ID = 'binder-design';

const EMPTY_LAYOUT = {
  version: 1,
  positions: {},
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

const ZOOM = 0.86;

const COLORS = {
  primary: 'rgb(53, 114, 255)',
  primaryHover: 'rgb(89, 144, 255)',
  primaryActive: 'rgb(33, 80, 210)',
  primaryBg: 'rgb(245, 249, 255)',
  primaryBorder: 'rgb(160, 198, 255)',
  border: 'rgb(232, 232, 236)',
  white: 'rgb(255, 255, 255)',
  gray50: 'rgb(246, 246, 247)',
  text: 'rgb(36, 36, 40)',
  textSecondary: 'rgb(138, 138, 151)',
  success: 'rgb(18, 183, 106)',
  successBg: 'rgb(232, 248, 240)',
  destructive: 'rgb(231, 0, 11)',
  destructiveBg: 'rgb(255, 232, 233)',
  ring: 'rgba(53, 114, 255, 0.36)',
  destructiveRing: 'rgba(231, 0, 11, 0.2)',
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
        numCandidates: 3,
        seed: 42,
        strategy: 'random',
        useTargetHotspots: true,
        designNote: '',
      }),
      node('node-designer', 'sequence-design', 'Sequence design', {
        model: 'vhh-designer-v1',
        temperature: 0.7,
        numDesigns: 2,
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
        topN: 2,
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

function buildLayout() {
  return {
    version: 1,
    positions: {
      'node-target': { x: 40, y: 40 },
      'node-generator': { x: 280, y: 40 },
      'node-designer': { x: 520, y: 40 },
      'node-predictor': { x: 40, y: 220 },
      'node-comparison': { x: 280, y: 220 },
    },
    viewport: { x: 0, y: 0, zoom: ZOOM },
    selection: { nodeId: null, edgeId: null },
  };
}

async function seedAndStartRun(
  page: Page,
  options: { missingTarget?: boolean } = {},
): Promise<string> {
  const registered = await page.request.post('/api/files', {
    data: { path: 'inputs/candidates.fasta' },
  });
  expect(registered.ok()).toBe(true);
  const reference = (await registered.json()) as {
    id: string;
    path: string;
    name: string;
  };

  const workflow = buildWorkflow(
    options.missingTarget
      ? { ...reference, id: 'missing-reference', path: 'targets/missing.pdb' }
      : reference,
  );
  const saved = await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: { name: 'Binder design', workflow, layout: buildLayout() },
  });
  expect(saved.ok()).toBe(true);

  const started = await page.request.post(`/api/workflows/${DRAFT_ID}/runs`, {
    data: {},
  });
  expect(started.status()).toBe(201);
  const run = (await started.json()) as { run: { id: string } };

  await page.reload();
  await expect(page.getByTestId('workflow-canvas')).toHaveAttribute('data-hydrated', 'true');
  return run.run.id;
}

async function resetDraft(page: Page): Promise<void> {
  await page.request.put(`/api/workflows/${DRAFT_ID}`, {
    data: {
      name: 'Binder design',
      workflow: { version: 1, nodes: [], edges: [] },
      layout: EMPTY_LAYOUT,
    },
  });
}

test.afterEach(async ({ page }) => {
  await resetDraft(page);
});

async function css(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name).trim(),
    property,
  );
}

async function boxShadow(locator: Locator): Promise<string> {
  return css(locator, 'box-shadow');
}

test('renders token-driven Button and Input states, focus rings, and no avatar or logo assets', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.locator('.login-brand')).toHaveText('SFlow');
  await expect(page.getByRole('heading', { name: 'Sign in to your Project' })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('[class*="avatar" i]').count()).toBe(0);

  const input = page.getByLabel('Project credential');
  const submit = page.getByRole('button', { name: 'Open workspace' });

  // The credential Input autofocuses on load; blur to observe the resting
  // border, then hover and focus through each token state.
  await expect(input).toBeFocused();
  await input.blur();
  expect(await css(input, 'border-top-color')).toBe(COLORS.border);
  await input.hover();
  expect(await css(input, 'border-top-color')).toBe(COLORS.primaryBorder);
  expect(await css(submit, 'background-color')).toBe(COLORS.primary);
  expect(await css(submit, 'color')).toBe(COLORS.white);
  expect(await css(submit, 'cursor')).toBe('not-allowed');
  expect(await css(submit, 'opacity')).toBe('0.5');

  // Input focus uses the primary border and the token ring.
  await input.focus();
  expect(await css(input, 'border-top-color')).toBe(COLORS.primary);
  expect(await boxShadow(input)).toContain(COLORS.ring);
  expect(await boxShadow(input)).toContain('2px');

  // The primary Button exposes hover and active token states.
  await input.fill('wrong-credential');
  await input.blur();
  await submit.hover();
  expect(await css(submit, 'background-color')).toBe(COLORS.primaryHover);
  const submitBox = await submit.boundingBox();
  expect(submitBox).not.toBeNull();
  await page.mouse.move(
    submitBox!.x + submitBox!.width / 2,
    submitBox!.y + submitBox!.height / 2,
  );
  await page.mouse.down();
  await expect
    .poll(async () => css(submit, 'background-color'))
    .toBe(COLORS.primaryActive);
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await expect(submit).toBeEnabled();

  // Keyboard focus stays visible with the token ring on the Button.
  await input.focus();
  await page.keyboard.press('Tab');
  expect(await css(submit, 'outline-style')).toBe('solid');
  expect(await css(submit, 'outline-width')).toBe('2px');
  expect(await css(submit, 'outline-color')).toBe(COLORS.ring);

  // Error semantics use the destructive border/ring and pair color with text.
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText('Invalid Project credential.');
  expect(await input.getAttribute('aria-invalid')).toBe('true');
  expect(await css(input, 'border-top-color')).toBe(COLORS.destructive);
  await input.focus();
  expect(await boxShadow(input)).toContain(COLORS.destructiveRing);
  expect(await css(page.getByRole('alert'), 'color')).toBe(COLORS.destructive);
});

test('renders token-driven Nav, Tabs, Card, Badge, and Progress from live Run data', async ({
  page,
}) => {
  await signIn(page);

  // Nav: the active entry uses primary-bg and primary text.
  const activeNav = page.getByTestId('nav-workflows');
  await expect(activeNav).toHaveAttribute('aria-current', 'page');
  expect(await css(activeNav, 'background-color')).toBe(COLORS.primaryBg);
  expect(await css(activeNav, 'color')).toBe(COLORS.primary);

  // Tabs: the selected monitor tab uses primary text and a 2px primary rule.
  const activeTab = page.getByTestId('monitor-tab-overview');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  expect(await css(activeTab, 'color')).toBe(COLORS.primary);
  expect(await css(activeTab, 'border-bottom-color')).toBe(COLORS.primary);
  expect(await css(activeTab, 'border-bottom-width')).toBe('2px');

  // Card: white surface, token border, and the large radius.
  const card = page.getByTestId('monitor-cards').locator('.card').first();
  await expect(card).toBeVisible();
  expect(await css(card, 'background-color')).toBe(COLORS.white);
  expect(await css(card, 'border-top-color')).toBe(COLORS.border);
  expect(await css(card, 'border-top-left-radius')).toBe('12px');

  // Neutral Badge for Project state with text paired to color.
  const projectState = page.getByTestId('project-state');
  await expect(projectState).toHaveText('Idle');
  expect(await css(projectState, 'background-color')).toBe(COLORS.gray50);
  expect(await css(projectState, 'color')).toBe(COLORS.textSecondary);

  // Complete the full deterministic 5-Node path and inspect its semantics.
  await seedAndStartRun(page);
  await expect(page.getByTestId('monitor-run-state')).toHaveText('completed', {
    timeout: 15_000,
  });

  const runStatus = page.getByTestId('monitor-run-status');
  await expect(runStatus).toHaveClass(/badge-success/);
  expect(await css(runStatus, 'color')).toBe(COLORS.success);
  expect(await css(runStatus, 'background-color')).toBe(COLORS.successBg);

  await expect(page.getByTestId('monitor-progress')).toContainText('5 / 5');
  await expect(page.getByTestId('monitor-progress-percent')).toHaveText('100% complete');
  const progress = page.getByRole('progressbar', { name: 'Completed Tasks' });
  expect(await progress.getAttribute('aria-valuemax')).toBe('5');
  expect(await progress.getAttribute('aria-valuenow')).toBe('5');
  expect(await css(progress, 'background-color')).toBe(COLORS.primaryBg);
  const fill = page.getByTestId('monitor-progress-fill');
  expect(await css(fill, 'background-color')).toBe(COLORS.primary);
  await expect
    .poll(async () => {
      const widths = await progress.evaluate((element) => ({
        track: element.getBoundingClientRect().width,
        fill: element.firstElementChild!.getBoundingClientRect().width,
      }));
      return Math.abs(widths.fill - widths.track);
    })
    .toBeLessThanOrEqual(1);

  // Task state Badges keep the success semantic with explicit text.
  await page.getByTestId('monitor-tab-tasks').click();
  const completedTasks = page.locator('[data-testid^="monitor-task-state-"]');
  await expect(completedTasks).toHaveCount(5);
  for (const taskState of await completedTasks.all()) {
    await expect(taskState).toHaveText('completed');
    await expect(taskState).toHaveClass(/badge-success/);
    expect(await css(taskState, 'color')).toBe(COLORS.success);
  }

  // A failed Run and Task use the destructive Badge state, not warning.
  await seedAndStartRun(page, { missingTarget: true });
  await expect(page.getByTestId('monitor-run-state')).toHaveText('failed', {
    timeout: 15_000,
  });
  const failedRun = page.getByTestId('monitor-run-status');
  await expect(failedRun).toHaveText('failed');
  await expect(failedRun).toHaveClass(/badge-destructive/);
  expect(await css(failedRun, 'color')).toBe(COLORS.destructive);
  expect(await css(failedRun, 'background-color')).toBe(COLORS.destructiveBg);

  await page.getByTestId('monitor-tab-tasks').click();
  const failedTask = page.locator(
    '[data-testid^="monitor-task-state-"][data-state="failed"]',
  );
  await expect(failedTask).toHaveText('failed');
  await expect(failedTask).toHaveClass(/badge-destructive/);
  expect(await css(failedTask, 'color')).toBe(COLORS.destructive);

  // Fixed viewport still holds with a completed and a failed Run in view.
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.innerHeight + 1);
});
