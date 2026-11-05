import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultParameters,
  type CreateRunResponse,
  type ErrorResponse,
  type FileReference,
  type RunDetailResponse,
  type RunListResponse,
  type ValidationDiagnostic,
  type ValidateWorkflowResponse,
  type WorkflowIR,
} from '@sflow/domain';
import {
  builtinManifestById,
} from '@sflow/nodes';
import {
  bootTestServer,
  getJson,
  login,
  postJson,
  putJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

const DRAFT_ID = 'binder-design';

function manifest(id: string) {
  const value = builtinManifestById(id);
  if (!value) throw new Error(`Missing built-in Manifest ${id}`);
  return value;
}

const emptyLayout = {
  version: 1,
  positions: {},
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

interface Fixture {
  workflow: WorkflowIR;
  nodeIds: Record<string, string>;
  fileReferenceValue: {
    fileReferenceId: string;
    path: string;
    name: string;
  };
}

function buildWorkflow(fileReference: FileReference): Fixture {
  const ids = {
    target: 'node-target',
    generator: 'node-generator',
    designer: 'node-designer',
    predictor: 'node-predictor',
    comparison: 'node-comparison',
  };
  const nodeIds = {
    target: ids.target,
    generator: ids.generator,
    designer: ids.designer,
    predictor: ids.predictor,
    comparison: ids.comparison,
  };
  const fileReferenceValue = {
    fileReferenceId: fileReference.id,
    path: fileReference.path,
    name: fileReference.name,
  };

  const nodes: WorkflowIR['nodes'] = [
    {
      id: ids.target,
      manifestId: 'target-input',
      manifestVersion: '1.0.0',
      label: 'Target input',
      parameters: {
        ...defaultParameters(manifest('target-input')),
        targetFile: fileReferenceValue,
      },
      resources: {},
    },
    {
      id: ids.generator,
      manifestId: 'candidate-generation',
      manifestVersion: '1.0.0',
      label: 'Candidate generation',
      parameters: defaultParameters(manifest('candidate-generation')),
      resources: {},
    },
    {
      id: ids.designer,
      manifestId: 'sequence-design',
      manifestVersion: '1.0.0',
      label: 'Sequence design',
      parameters: defaultParameters(manifest('sequence-design')),
      resources: {},
    },
    {
      id: ids.predictor,
      manifestId: 'structure-prediction',
      manifestVersion: '1.0.0',
      label: 'Structure prediction',
      parameters: defaultParameters(manifest('structure-prediction')),
      resources: {},
    },
    {
      id: ids.comparison,
      manifestId: 'candidate-comparison',
      manifestVersion: '1.0.0',
      label: 'Candidate comparison',
      parameters: defaultParameters(manifest('candidate-comparison')),
      resources: {},
    },
  ];

  const connect = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ): WorkflowIR['edges'][number] => ({ id, source, sourcePort, target, targetPort });

  return {
    workflow: {
      version: 1,
      id: DRAFT_ID,
      name: 'Binder design',
      nodes,
      edges: [
        connect('e-target-data', ids.target, 'target', ids.generator, 'target'),
        connect('e-target-control', ids.target, 'control-out', ids.generator, 'control-in'),
        connect('e-generator-data', ids.generator, 'candidates', ids.designer, 'candidates'),
        connect('e-generator-control', ids.generator, 'control-out', ids.designer, 'control-in'),
        connect('e-designer-data', ids.designer, 'designs', ids.predictor, 'designs'),
        connect('e-designer-control', ids.designer, 'control-out', ids.predictor, 'control-in'),
        connect('e-predictor-data', ids.predictor, 'scored', ids.comparison, 'scored'),
        connect('e-predictor-control', ids.predictor, 'control-out', ids.comparison, 'control-in'),
      ],
    },
    nodeIds,
    fileReferenceValue,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('Workflow validation and Run snapshots API', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(): Promise<{ cookie: string; root: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-validation-'));
    mkdirSync(join(projectRoot, 'inputs'), { recursive: true });
    writeFileSync(join(projectRoot, 'inputs', 'candidates.fasta'), '>candidate-1\nMKTAYIAKQR\n');
    writeFileSync(join(projectRoot, 'target.pdb'), 'HEADER TARGET\n');

    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    return { cookie: sessionCookie(accepted)!, root: projectRoot };
  }

  async function saveFixture(
    cookie: string,
    fixture: Fixture,
    layout: Record<string, unknown> = emptyLayout,
  ): Promise<void> {
    const response = await putJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow: fixture.workflow, layout },
      cookie,
    );
    expect(response.status).toBe(200);
  }

  async function registerTarget(cookie: string): Promise<FileReference> {
    const response = await postJson(
      `${handle!.url}/api/files`,
      { path: 'inputs/candidates.fasta' },
      cookie,
    );
    expect(response.status).toBe(200);
    return readJson<FileReference>(response);
  }

  async function validateDraft(cookie: string): Promise<ValidateWorkflowResponse> {
    const response = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/validate`,
      {},
      cookie,
    );
    expect(response.status).toBe(200);
    return readJson<ValidateWorkflowResponse>(response);
  }

  function codes(result: ValidateWorkflowResponse): string[] {
    return result.diagnostics.map((diagnostic) => diagnostic.code);
  }

  it('validates the current draft and reports an executable Binder Workflow as valid', async () => {
    const { cookie } = await boot();
    const fixture = buildWorkflow(await registerTarget(cookie));
    await saveFixture(cookie, fixture);

    const result = await validateDraft(cookie);

    expect(result).toEqual({ valid: true, diagnostics: [] });
  });

  it('reports invalid ports, missing inputs, parameter errors, and resource errors with Node or connection identity', async () => {
    const { cookie } = await boot();
    const fixture = buildWorkflow(await registerTarget(cookie));

    fixture.workflow.edges = fixture.workflow.edges.filter(
      (edge) => edge.id !== 'e-designer-control',
    );
    fixture.workflow.edges[0] = {
      ...fixture.workflow.edges[0],
      sourcePort: 'not-a-port',
    };
    fixture.workflow.nodes = fixture.workflow.nodes.map((node) => {
      if (node.id === fixture.nodeIds.generator) {
        return {
          ...node,
          parameters: { ...node.parameters, numCandidates: 0 },
          resources: { gpuType: 'A100' },
        };
      }
      return node;
    });
    await saveFixture(cookie, fixture);

    const result = await validateDraft(cookie);

    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'INVALID_PORT',
        'MISSING_INPUT',
        'PARAMETER_ERROR',
        'RESOURCE_ERROR',
      ]),
    );

    const invalidPort = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'INVALID_PORT',
    );
    expect(invalidPort).toMatchObject({
      nodeId: fixture.nodeIds.target,
      edgeId: 'e-target-data',
    });
    expect(invalidPort?.correction).toContain('declared outputs');

    const missingInput = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'MISSING_INPUT',
    );
    expect(missingInput).toMatchObject({
      nodeId: fixture.nodeIds.predictor,
      correction: expect.stringContaining('control-in'),
    });

    const parameter = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'PARAMETER_ERROR',
    );
    expect(parameter).toMatchObject({
      nodeId: fixture.nodeIds.generator,
      path: expect.stringContaining('numCandidates'),
    });

    const resource = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'RESOURCE_ERROR',
    );
    expect(resource).toMatchObject({
      nodeId: fixture.nodeIds.generator,
      correction: expect.stringContaining('GPU'),
    });
  });

  it('reports impossible dependencies and missing Binder outputs', async () => {
    const { cookie } = await boot();
    const fixture = buildWorkflow(await registerTarget(cookie));

    fixture.workflow.edges = fixture.workflow.edges.filter(
      (edge) =>
        edge.source !== fixture.nodeIds.comparison &&
        edge.target !== fixture.nodeIds.comparison,
    );
    fixture.workflow.nodes = fixture.workflow.nodes.filter(
      (node) => node.id !== fixture.nodeIds.comparison,
    );
    fixture.workflow.edges.push({
      id: 'dangling',
      source: fixture.nodeIds.generator,
      sourcePort: 'candidates',
      target: 'ghost-node',
      targetPort: 'candidates',
    });
    fixture.workflow.edges.push({
      id: 'cycle-back',
      source: fixture.nodeIds.designer,
      sourcePort: 'control-out',
      target: fixture.nodeIds.generator,
      targetPort: 'out-of-band',
    });
    await saveFixture(cookie, fixture);

    const result = await validateDraft(cookie);

    expect(result.valid).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'UNSATISFIED_DEPENDENCY',
        'MISSING_BINDER_OUTPUT',
        'CYCLE',
      ]),
    );
    const missing = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'MISSING_BINDER_OUTPUT',
    );
    expect(missing).toHaveLength(2);
    expect(missing[0].correction).toContain('Candidate comparison');
    expect(missing[0].nodeId).toBe(fixture.nodeIds.predictor);
  });

  it('rejects Run creation with 422 VALIDATION_FAILED and diagnostics until validation passes', async () => {
    const { cookie } = await boot();
    await putJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow: { version: 1, nodes: [], edges: [] }, layout: emptyLayout },
      cookie,
    );

    const rejected = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(rejected.status).toBe(422);
    const error = await readJson<ErrorResponse>(rejected);
    expect(error.error.code).toBe('VALIDATION_FAILED');
    const details = error.error.details as { diagnostics: ValidationDiagnostic[] };
    expect(details.diagnostics.length).toBeGreaterThan(0);
    expect(details.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: expect.any(String),
      message: expect.any(String),
      correction: expect.any(String),
    });

    const runsAfterRejection = await readJson<RunListResponse>(
      await getJson(`${handle!.url}/api/runs`, cookie),
    );
    expect(runsAfterRejection.runs).toEqual([]);

    const fixture = buildWorkflow(await registerTarget(cookie));
    await saveFixture(cookie, fixture);
    const accepted = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(accepted.status).toBe(201);
    const { run } = await readJson<CreateRunResponse>(accepted);
    expect(run.status).toBe('queued');
  });

  it('creates a queued Run with an immutable snapshot of the exact execution contract', async () => {
    const { cookie, root } = await boot();
    const fixture = buildWorkflow(await registerTarget(cookie));
    const layout = {
      version: 1,
      positions: { [fixture.nodeIds.target]: { x: 120, y: 64 } },
      viewport: { x: -40, y: 22, zoom: 1.1 },
      selection: { nodeId: fixture.nodeIds.target, edgeId: null },
      panelWidths: { explorer: 300, agent: 348 },
      collapsed: { explorer: false, agent: true },
      maximize: true,
      libraryQuery: 'fold',
      libraryCategory: 'structure-prediction',
      agentGeometry: { ball: { x: 1, y: 2 }, panel: { width: 360, height: 340 } },
    };
    await saveFixture(cookie, fixture, layout);

    const response = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(response.status).toBe(201);
    const { run } = await readJson<CreateRunResponse>(response);

    expect(Object.keys(run).sort()).toEqual([
      'createdAt',
      'id',
      'snapshot',
      'status',
      'updatedAt',
      'workflowId',
    ]);
    expect(run.workflowId).toBe(DRAFT_ID);
    expect(run.status).toBe('queued');
    expect(run.createdAt).toBeTruthy();
    expect(run.updatedAt).toBe(run.createdAt);

    expect(Object.keys(run.snapshot).sort()).toEqual(['nodes', 'version', 'workflow']);
    expect(run.snapshot.version).toBe(1);
    expect(run.snapshot.workflow).toEqual(fixture.workflow);
    expect(run.snapshot.nodes).toHaveLength(5);

    const targetSnapshot = run.snapshot.nodes.find(
      (node) => node.manifestId === 'target-input',
    );
    expect(targetSnapshot).toEqual({
      nodeId: fixture.nodeIds.target,
      label: 'Target input',
      manifestId: 'target-input',
      manifestVersion: '1.0.0',
      parameters: {
        targetChain: 'A',
        hotspotResidues: '',
        targetFile: {
          ...fixture.fileReferenceValue,
        },
      },
      resources: { cpu: 1, memory: '2Gi', walltimeMinutes: 10 },
      environment: {
        kind: 'container',
        image: 'ghcr.io/sflow/nodes/target-input:1.0.0',
      },
      retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
      fileReferences: [
        {
          parameterId: 'targetFile',
          ...fixture.fileReferenceValue,
        },
      ],
    });
    expect(
      run.snapshot.nodes.find((node) => node.manifestId === 'sequence-design'),
    ).toMatchObject({
      manifestId: 'sequence-design',
      manifestVersion: '1.0.0',
      resources: {
        cpu: 8,
        memory: '32Gi',
        gpu: 1,
        gpuType: 'A100',
        walltimeMinutes: 120,
      },
      environment: {
        kind: 'container',
        image: 'ghcr.io/sflow/nodes/sequence-design:1.0.0',
      },
      parameters: {
        model: 'vhh-designer-v1',
        temperature: 0.7,
        numDesigns: 50,
        randomSeed: 7,
        trimTerminalTags: true,
      },
    });

    // Layout and presentation state never enters the snapshot.
    const serialized = JSON.stringify(run.snapshot);
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
    expect(serialized).not.toContain('node-target":{"x"');

    // The Run is retrievable and persisted in Project state. Execution starts
    // immediately, so the immutable snapshot — not the live status — is the
    // fact this test pins.
    const fetched = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${run.id}`, cookie),
    );
    expect(fetched.run.id).toBe(run.id);
    expect(fetched.run.workflowId).toBe(run.workflowId);
    expect(fetched.run.snapshot).toEqual(run.snapshot);
    expect(fetched.tasks).toHaveLength(5);

    await handle!.close({ cleanupProject: false });
    handle = undefined;
    handle = await bootTestServer({ projectRoot: root });
    const accepted = await login(handle.url, handle.credential);
    const afterRestart = await readJson<RunDetailResponse>(
      await getJson(`${handle.url}/api/runs/${run.id}`, sessionCookie(accepted)!),
    );
    expect(afterRestart.run.id).toBe(run.id);
    expect(afterRestart.run.snapshot).toEqual(run.snapshot);
    expect(afterRestart.tasks).toHaveLength(5);
  });

  it('keeps Runs unchanged after later draft edits while future Runs see the edits', async () => {
    const { cookie } = await boot();
    const fixture = buildWorkflow(await registerTarget(cookie));
    await saveFixture(cookie, fixture);

    const first = await readJson<CreateRunResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );

    const edited = clone(fixture.workflow);
    edited.nodes = edited.nodes.map((node) => {
      if (node.id === fixture.nodeIds.target) {
        return {
          ...node,
          label: 'Target input (edited)',
          parameters: { ...node.parameters, targetChain: 'B' },
        };
      }
      if (node.id === fixture.nodeIds.generator) {
        return {
          ...node,
          parameters: { ...node.parameters, numCandidates: 500 },
        };
      }
      return node;
    });
    await putJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}`,
      {
        name: 'Binder design',
        workflow: edited,
        layout: {
          ...emptyLayout,
          positions: { [fixture.nodeIds.target]: { x: 999, y: 999 } },
        },
      },
      cookie,
    );

    const fetchedAfterEdit = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${first.run.id}`, cookie),
    );
    expect(fetchedAfterEdit.run.snapshot).toEqual(first.run.snapshot);
    expect(
      fetchedAfterEdit.run.snapshot.workflow.nodes.find(
        (node) => node.id === fixture.nodeIds.target,
      )?.label,
    ).toBe('Target input');
    expect(
      fetchedAfterEdit.run.snapshot.nodes.find(
        (node) => node.nodeId === fixture.nodeIds.generator,
      )?.parameters.numCandidates,
    ).toBe(100);

    const second = await readJson<CreateRunResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );
    expect(second.run.id).not.toBe(first.run.id);
    expect(
      second.run.snapshot.workflow.nodes.find(
        (node) => node.id === fixture.nodeIds.target,
      )?.label,
    ).toBe('Target input (edited)');
    expect(
      second.run.snapshot.nodes.find(
        (node) => node.nodeId === fixture.nodeIds.generator,
      )?.parameters.numCandidates,
    ).toBe(500);

    const listed = await readJson<RunListResponse>(
      await getJson(`${handle!.url}/api/runs`, cookie),
    );
    expect(listed.runs.map((run) => run.id)).toEqual([second.run.id, first.run.id]);
    expect(listed.runs.find((run) => run.id === first.run.id)?.snapshot).toEqual(
      first.run.snapshot,
    );
  });

  it('requires authentication and returns 404 for unknown drafts and Runs', async () => {
    const { cookie } = await boot();

    expect(
      (await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {})).status,
    ).toBe(401);
    expect((await getJson(`${handle!.url}/api/runs`)).status).toBe(401);
    expect(
      (
        await postJson(
          `${handle!.url}/api/workflows/missing/validate`,
          {},
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (await postJson(`${handle!.url}/api/workflows/missing/runs`, {}, cookie)).status,
    ).toBe(404);
    expect(
      (await getJson(`${handle!.url}/api/runs/missing`, cookie)).status,
    ).toBe(404);
  });
});
