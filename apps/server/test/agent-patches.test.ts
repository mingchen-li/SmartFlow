import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultParameters,
  type AgentPatch,
  type AgentPatchWorkflowResponse,
  type ErrorResponse,
  type FileReference,
  type WorkflowDraft,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinManifestById } from '@sflow/nodes';
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

const LAYOUT = {
  version: 1,
  positions: {
    'node-target': { x: 80, y: 80 },
    'node-generator': { x: 310, y: 80 },
  },
  viewport: { x: 12, y: -4, zoom: 0.74 },
  selection: { nodeId: 'node-generator', edgeId: null },
};

function buildWorkflow(fileReference: FileReference): WorkflowIR {
  const fileReferenceValue = {
    fileReferenceId: fileReference.id,
    path: fileReference.path,
    name: fileReference.name,
  };

  const connect = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ): WorkflowIR['edges'][number] => ({ id, source, sourcePort, target, targetPort });

  return {
    version: 1,
    id: DRAFT_ID,
    name: 'Binder design',
    nodes: [
      {
        id: 'node-target',
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
        id: 'node-generator',
        manifestId: 'candidate-generation',
        manifestVersion: '1.0.0',
        label: 'Candidate generation',
        parameters: defaultParameters(manifest('candidate-generation')),
        resources: {},
      },
      {
        id: 'node-designer',
        manifestId: 'sequence-design',
        manifestVersion: '1.0.0',
        label: 'Sequence design',
        parameters: defaultParameters(manifest('sequence-design')),
        resources: {},
      },
      {
        id: 'node-predictor',
        manifestId: 'structure-prediction',
        manifestVersion: '1.0.0',
        label: 'Structure prediction',
        parameters: defaultParameters(manifest('structure-prediction')),
        resources: {},
      },
      {
        id: 'node-comparison',
        manifestId: 'candidate-comparison',
        manifestVersion: '1.0.0',
        label: 'Candidate comparison',
        parameters: defaultParameters(manifest('candidate-comparison')),
        resources: {},
      },
    ],
    edges: [
      connect('e-target-data', 'node-target', 'target', 'node-generator', 'target'),
      connect('e-target-control', 'node-target', 'control-out', 'node-generator', 'control-in'),
      connect('e-generator-data', 'node-generator', 'candidates', 'node-designer', 'candidates'),
      connect('e-generator-control', 'node-generator', 'control-out', 'node-designer', 'control-in'),
      connect('e-designer-data', 'node-designer', 'designs', 'node-predictor', 'designs'),
      connect('e-designer-control', 'node-designer', 'control-out', 'node-predictor', 'control-in'),
      connect('e-predictor-data', 'node-predictor', 'scored', 'node-comparison', 'scored'),
      connect('e-predictor-control', 'node-predictor', 'control-out', 'node-comparison', 'control-in'),
    ],
  };
}

const REPLACE_COUNT = {
  op: 'replace' as const,
  path: '/nodes/1/parameters/numCandidates',
  value: 250,
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'workflow',
    target: { kind: 'workflow', workflowId: DRAFT_ID, nodeId: 'node-generator' },
    baseRevision: 1,
    summary: 'Increase candidate count to 250',
    operations: [REPLACE_COUNT],
    ...overrides,
  };
}

interface Context {
  handle: TestServerHandle;
  cookie: string;
  draft: WorkflowDraft;
  workflow: WorkflowIR;
}

describe('Agent patch API', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(): Promise<Context> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-agent-'));
    mkdirSync(join(projectRoot, 'inputs'), { recursive: true });
    writeFileSync(join(projectRoot, 'inputs', 'candidates.fasta'), '>candidate-1\nMKTAYIAKQR\n');

    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;

    const registered = await postJson(
      `${handle.url}/api/files`,
      { path: 'inputs/candidates.fasta' },
      cookie,
    );
    const fileReference = await readJson<FileReference>(registered);

    const workflow = buildWorkflow(fileReference);
    const saved = await putJson(
      `${handle.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow, layout: LAYOUT },
      cookie,
    );
    expect(saved.status).toBe(200);
    const draft = await readJson<WorkflowDraft>(saved);
    expect(draft.revision).toBe(1);

    return { handle, cookie, draft, workflow };
  }

  function url(path: string): string {
    return `${handle!.url}${path}`;
  }

  async function propose(context: Context, body: unknown): Promise<Response> {
    return postJson(url(`/api/workflows/${DRAFT_ID}/agent/patches`), body, context.cookie);
  }

  async function apply(context: Context, patchId: string): Promise<Response> {
    return postJson(url(`/api/agent/patches/${patchId}/apply`), {}, context.cookie);
  }

  async function revert(context: Context, patchId: string): Promise<Response> {
    return postJson(url(`/api/agent/patches/${patchId}/revert`), {}, context.cookie);
  }

  async function reject(context: Context, patchId: string): Promise<Response> {
    return postJson(url(`/api/agent/patches/${patchId}/reject`), {}, context.cookie);
  }

  async function getPatch(context: Context, patchId: string): Promise<AgentPatch> {
    const response = await getJson(url(`/api/agent/patches/${patchId}`), context.cookie);
    expect(response.status).toBe(200);
    return (await readJson<{ patch: AgentPatch }>(response)).patch;
  }

  async function getDraft(context: Context): Promise<WorkflowDraft> {
    const response = await getJson(url(`/api/workflows/${DRAFT_ID}`), context.cookie);
    expect(response.status).toBe(200);
    return readJson<WorkflowDraft>(response);
  }

  async function errorBody(response: Response): Promise<ErrorResponse> {
    return readJson<ErrorResponse>(response);
  }

  function generatorCount(workflow: WorkflowIR): unknown {
    return workflow.nodes.find((node) => node.id === 'node-generator')?.parameters
      .numCandidates;
  }

  it('proposes a validated typed patch, previews the diff, and serves it by id', async () => {
    const context = await boot();
    const response = await propose(context, proposal());

    expect(response.status).toBe(201);
    const patch = (await readJson<{ patch: AgentPatch }>(response)).patch;
    expect(patch).toMatchObject({
      workflowId: DRAFT_ID,
      scope: 'workflow',
      target: { kind: 'workflow', workflowId: DRAFT_ID, nodeId: 'node-generator' },
      baseRevision: 1,
      resultRevision: null,
      status: 'proposed',
      summary: 'Increase candidate count to 250',
    });
    expect(patch.validation).toEqual({
      valid: true,
      schemaValid: true,
      semanticValid: true,
      diagnostics: [],
    });
    expect(patch.diff).toHaveLength(1);
    expect(patch.diff[0]).toMatchObject({
      operation: 0,
      op: 'replace',
      path: '/nodes/1/parameters/numCandidates',
      before: 100,
      after: 250,
    });
    expect(patch.diff[0].description).toContain('numCandidates');
    expect(patch.operations).toEqual([REPLACE_COUNT]);
    expect(patch.inverseOperations).toEqual([]);
    expect(patch.appliedAt).toBeNull();
    expect(patch.revertedAt).toBeNull();

    expect(await getPatch(context, patch.id)).toEqual(patch);

    // Proposal never mutates the draft.
    const draft = await getDraft(context);
    expect(draft.revision).toBe(1);
    expect(generatorCount(draft.workflow as unknown as WorkflowIR)).toBe(100);
  });

  it('rejects schema-invalid patches with diagnostics and refuses to apply them', async () => {
    const context = await boot();
    const response = await propose(
      context,
      proposal({
        summary: 'Leak layout into Workflow IR',
        operations: [{ op: 'add', path: '/positions', value: {} }],
      }),
    );

    expect(response.status).toBe(201);
    const patch = (await readJson<{ patch: AgentPatch }>(response)).patch;
    expect(patch.status).toBe('rejected');
    expect(patch.validation.valid).toBe(false);
    expect(patch.validation.schemaValid).toBe(false);
    expect(patch.validation.semanticValid).toBe(false);
    expect(patch.validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'INVALID_WORKFLOW',
    );

    const applied = await apply(context, patch.id);
    expect(applied.status).toBe(409);
    const body = await errorBody(applied);
    expect(body.error.code).toBe('PATCH_NOT_APPLICABLE');

    const draft = await getDraft(context);
    expect(draft.revision).toBe(1);
    expect('positions' in (draft.workflow as Record<string, unknown>)).toBe(false);
  });

  it('rejects semantically invalid patches through the shared Workflow validator', async () => {
    const context = await boot();
    const response = await propose(
      context,
      proposal({
        summary: 'Set an invalid candidate count',
        operations: [
          { op: 'replace', path: '/nodes/1/parameters/numCandidates', value: 0 },
        ],
      }),
    );

    const patch = (await readJson<{ patch: AgentPatch }>(response)).patch;
    expect(patch.status).toBe('rejected');
    expect(patch.validation.schemaValid).toBe(true);
    expect(patch.validation.semanticValid).toBe(false);
    expect(patch.validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PARAMETER_ERROR',
    );
    expect(patch.validation.diagnostics[0]?.correction).toBeTruthy();

    const applied = await apply(context, patch.id);
    expect(applied.status).toBe(409);
  });

  it('rejects patches whose operations cannot be applied and reports the failing path', async () => {
    const context = await boot();
    const response = await propose(
      context,
      proposal({
        summary: 'Patch a Node that does not exist',
        operations: [{ op: 'replace', path: '/nodes/99/label', value: 'Missing' }],
      }),
    );

    const patch = (await readJson<{ patch: AgentPatch }>(response)).patch;
    expect(patch.status).toBe('rejected');
    expect(patch.validation.valid).toBe(false);
    expect(patch.validation.diagnostics[0]).toMatchObject({
      code: 'PATCH_APPLICATION_ERROR',
      path: '/nodes/99/label',
    });
  });

  it('applies a valid proposal to the draft Workflow IR only and bumps the draft revision', async () => {
    const context = await boot();
    const proposed = await propose(context, proposal());
    const patch = (await readJson<{ patch: AgentPatch }>(proposed)).patch;

    const response = await apply(context, patch.id);
    expect(response.status).toBe(200);
    const result = await readJson<AgentPatchWorkflowResponse>(response);

    expect(result.patch.status).toBe('applied');
    expect(result.patch.resultRevision).toBe(2);
    expect(result.patch.appliedAt).toBeTruthy();
    expect(result.patch.inverseOperations).toEqual([
      { op: 'replace', path: '/nodes/1/parameters/numCandidates', value: 100 },
    ]);
    expect(result.revision).toBe(2);
    expect(generatorCount(result.workflow)).toBe(250);

    const draft = await getDraft(context);
    expect(draft.revision).toBe(2);
    expect(generatorCount(draft.workflow as unknown as WorkflowIR)).toBe(250);
    // Layout is UI state and is preserved byte-for-byte by the patch.
    expect(draft.layout).toEqual(LAYOUT);

    // Semantic validation still passes after application.
    const validation = await postJson(
      url(`/api/workflows/${DRAFT_ID}/validate`),
      {},
      context.cookie,
    );
    expect(await readJson<{ valid: boolean }>(validation)).toEqual({
      valid: true,
      diagnostics: [],
    });

    // A patch can only be applied once.
    const second = await apply(context, patch.id);
    expect(second.status).toBe(409);
    expect((await errorBody(second)).error.code).toBe('PATCH_NOT_APPLICABLE');
  });

  it('rejects a stale base revision with 409 and never silently rebases', async () => {
    const context = await boot();
    const proposed = await propose(context, proposal());
    const patch = (await readJson<{ patch: AgentPatch }>(proposed)).patch;

    // A normal user edit changes the Workflow IR and moves the draft revision.
    const edited = structuredClone(context.workflow);
    edited.nodes[0]!.label = 'Target input (user edit)';
    const saved = await putJson(
      url(`/api/workflows/${DRAFT_ID}`),
      { name: 'Binder design', workflow: edited, layout: LAYOUT },
      context.cookie,
    );
    expect((await readJson<WorkflowDraft>(saved)).revision).toBe(2);

    const response = await apply(context, patch.id);
    expect(response.status).toBe(409);
    const body = await errorBody(response);
    expect(body.error.code).toBe('STALE_BASE');
    expect(body.error.details).toMatchObject({
      baseRevision: 1,
      currentRevision: 2,
    });

    const draft = await getDraft(context);
    expect(draft.revision).toBe(2);
    expect(generatorCount(draft.workflow as unknown as WorkflowIR)).toBe(100);
    expect((await getPatch(context, patch.id)).status).toBe('proposed');

    // A fresh proposal against the current revision succeeds.
    const rebased = await propose(context, proposal({ baseRevision: 2 }));
    expect(rebased.status).toBe(201);
    expect((await readJson<{ patch: AgentPatch }>(rebased)).patch.status).toBe('proposed');
  });

  it('rejects a proposal whose base revision is already stale', async () => {
    const context = await boot();
    const response = await propose(context, proposal({ baseRevision: 0 }));
    expect(response.status).toBe(409);
    expect((await errorBody(response)).error.code).toBe('STALE_BASE');
  });

  it('reverts an applied patch, restores the prior Workflow, and bumps the revision', async () => {
    const context = await boot();
    const proposed = await propose(context, proposal());
    const patch = (await readJson<{ patch: AgentPatch }>(proposed)).patch;
    expect((await apply(context, patch.id)).status).toBe(200);

    const response = await revert(context, patch.id);
    expect(response.status).toBe(200);
    const result = await readJson<AgentPatchWorkflowResponse>(response);
    expect(result.patch.status).toBe('reverted');
    expect(result.patch.revertedAt).toBeTruthy();
    expect(result.revision).toBe(3);
    expect(generatorCount(result.workflow)).toBe(100);

    const draft = await getDraft(context);
    expect(draft.revision).toBe(3);
    expect(generatorCount(draft.workflow as unknown as WorkflowIR)).toBe(100);
    expect(draft.layout).toEqual(LAYOUT);

    const second = await revert(context, patch.id);
    expect(second.status).toBe(409);
    expect((await errorBody(second)).error.code).toBe('PATCH_NOT_APPLIED');
  });

  it('refuses to revert over a newer Workflow and keeps the user change', async () => {
    const context = await boot();
    const proposed = await propose(context, proposal());
    const patch = (await readJson<{ patch: AgentPatch }>(proposed)).patch;
    expect((await apply(context, patch.id)).status).toBe(200);

    const appliedDraft = await getDraft(context);
    const edited = structuredClone(
      appliedDraft.workflow as unknown as WorkflowIR,
    );
    edited.nodes[1]!.label = 'Candidates (user edit)';
    const saved = await putJson(
      url(`/api/workflows/${DRAFT_ID}`),
      { name: 'Binder design', workflow: edited, layout: LAYOUT },
      context.cookie,
    );
    expect((await readJson<WorkflowDraft>(saved)).revision).toBe(3);

    const response = await revert(context, patch.id);
    expect(response.status).toBe(409);
    const body = await errorBody(response);
    expect(body.error.code).toBe('STALE_BASE');
    expect(body.error.details).toMatchObject({
      appliedRevision: 2,
      currentRevision: 3,
    });

    const draft = await getDraft(context);
    expect(draft.revision).toBe(3);
    expect(generatorCount(draft.workflow as unknown as WorkflowIR)).toBe(250);
    expect(
      (draft.workflow as unknown as WorkflowIR).nodes[1]!.label,
    ).toBe('Candidates (user edit)');
  });

  it('supports explicit rejection and refuses to reject or apply terminal patches', async () => {
    const context = await boot();
    const proposed = await propose(context, proposal());
    const patch = (await readJson<{ patch: AgentPatch }>(proposed)).patch;

    const response = await reject(context, patch.id);
    expect(response.status).toBe(200);
    expect((await readJson<{ patch: AgentPatch }>(response)).patch.status).toBe('rejected');
    expect((await getPatch(context, patch.id)).status).toBe('rejected');

    const applied = await apply(context, patch.id);
    expect(applied.status).toBe(409);
    expect((await errorBody(applied)).error.code).toBe('PATCH_NOT_APPLICABLE');

    const secondReject = await reject(context, patch.id);
    expect(secondReject.status).toBe(409);
  });

  it('keeps draft revision stable for layout-only saves', async () => {
    const context = await boot();
    const saved = await putJson(
      url(`/api/workflows/${DRAFT_ID}`),
      {
        name: 'Binder design',
        workflow: context.workflow,
        layout: { ...LAYOUT, viewport: { x: 30, y: 40, zoom: 1.1 } },
      },
      context.cookie,
    );
    expect(saved.status).toBe(200);
    const draft = await readJson<WorkflowDraft>(saved);
    expect(draft.revision).toBe(1);
    expect(draft.layout).toMatchObject({ viewport: { x: 30, y: 40, zoom: 1.1 } });
  });

  it('validates target identity and unsupported scopes without writing a draft', async () => {
    const context = await boot();

    const wrongTarget = await propose(
      context,
      proposal({ target: { kind: 'workflow', workflowId: 'other-workflow' } }),
    );
    expect(wrongTarget.status).toBe(422);
    expect((await errorBody(wrongTarget)).error.code).toBe('INVALID_TARGET');

    const resultView = await propose(
      context,
      proposal({
        scope: 'result-view',
        target: { kind: 'result-view', resultViewId: 'result-1' },
      }),
    );
    expect(resultView.status).toBe(422);
    expect((await errorBody(resultView)).error.code).toBe('UNSUPPORTED_SCOPE');

    const malformed = await propose(context, { ...proposal(), extra: true });
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).error.code).toBe('VALIDATION_ERROR');

    expect((await getDraft(context)).revision).toBe(1);
  });
});
