import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResultViewCompatibilityReportSchema,
  ResultViewIRSchema,
  WidgetCatalogResponseSchema,
  defaultParameters,
  type CreateRunResponse,
  type FileReference,
  type Run,
  type RunDetailResponse,
  type WidgetCatalogResponse,
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

const emptyLayout = {
  version: 1,
  positions: {},
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

const NODE_IDS = {
  target: 'node-target',
  generator: 'node-generator',
  comparison: 'node-comparison',
};

const TARGET_PDB = [
  'HEADER TARGET',
  'ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N',
  'ATOM      2  CA  ALA A   1      12.560   6.134  -6.504  1.00  0.00           C',
  'END',
].join('\n');

function buildWorkflow(fileReference: FileReference): WorkflowIR {
  const params = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...defaultParameters(manifest(id)),
    ...overrides,
  });

  return {
    version: 1,
    id: DRAFT_ID,
    name: 'Binder design',
    nodes: [
      {
        id: NODE_IDS.target,
        manifestId: 'target-input',
        manifestVersion: '1.0.0',
        label: 'Target input',
        parameters: params('target-input', {
          targetFile: {
            fileReferenceId: fileReference.id,
            path: fileReference.path,
            name: fileReference.name,
          },
        }),
        resources: {},
      },
      {
        id: NODE_IDS.generator,
        manifestId: 'candidate-generation',
        manifestVersion: '1.0.0',
        label: 'Candidate generation',
        parameters: params('candidate-generation', {
          numCandidates: 4,
          seed: 42,
        }),
        resources: {},
      },
      {
        id: NODE_IDS.comparison,
        manifestId: 'candidate-comparison',
        manifestVersion: '1.0.0',
        label: 'Candidate comparison',
        parameters: params('candidate-comparison', { topN: 2, label: 'round-1' }),
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
}

async function waitForTerminal(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
): Promise<RunDetailResponse> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const detail = await readJson<RunDetailResponse>(
      await getJson(`${handle.url}/api/runs/${runId}`, cookie),
    );
    if (['completed', 'failed', 'canceled'].includes(detail.run.status)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} did not reach a terminal state.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Result View API', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(): Promise<{
    cookie: string;
    fileReference: FileReference;
    root: string;
  }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-result-view-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);

    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;
    const registered = await postJson(
      `${handle.url}/api/files`,
      { path: 'targets/target.pdb' },
      cookie,
    );
    expect(registered.status).toBe(200);
    const fileReference = await readJson<FileReference>(registered);
    return { cookie, fileReference, root: projectRoot };
  }

  async function saveWorkflow(cookie: string, workflow: WorkflowIR): Promise<void> {
    const response = await putJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow, layout: emptyLayout },
      cookie,
    );
    expect(response.status).toBe(200);
  }

  async function startRun(cookie: string): Promise<Run> {
    const response = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(response.status).toBe(201);
    return (await readJson<CreateRunResponse>(response)).run;
  }

  it('exposes registered Widget descriptors and serves a durable default Result View for a Run', async () => {
    const { cookie, fileReference, root } = await boot();

    expect((await getJson(`${handle!.url}/api/widgets`)).status).toBe(401);
    const catalogResponse = await getJson(`${handle!.url}/api/widgets`, cookie);
    expect(catalogResponse.status).toBe(200);
    const catalog = await readJson<WidgetCatalogResponse>(catalogResponse);
    expect(WidgetCatalogResponseSchema.parse(catalog)).toEqual(catalog);
    const widgetIds = catalog.widgets.map((widget) => widget.id);
    expect(widgetIds).toEqual(
      expect.arrayContaining([
        'sflow.candidate-table',
        'sflow.metric-summary',
        'sflow.structure-viewer',
      ]),
    );
    const candidateWidget = catalog.widgets.find(
      (widget) => widget.id === 'sflow.candidate-table',
    );
    expect(candidateWidget).toMatchObject({
      acceptedArtifactSchemas: [
        { namespace: 'sflow.binder', name: 'candidate-set', version: '1.0.0' },
      ],
      interactions: expect.arrayContaining(['inspect', 'download']),
    });

    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const created = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, created.id);
    expect(detail.run.status).toBe('completed');

    expect(
      (await getJson(`${handle!.url}/api/runs/${created.id}/result-view`)).status,
    ).toBe(401);
    expect(
      (await getJson(`${handle!.url}/api/runs/missing/result-view`, cookie)).status,
    ).toBe(404);

    const response = await getJson(
      `${handle!.url}/api/runs/${created.id}/result-view`,
      cookie,
    );
    expect(response.status).toBe(200);
    const body = await readJson<{
      resultView: unknown;
      widgets: unknown[];
      data: { run: Run; tasks: unknown[]; artifacts: unknown[]; metrics: unknown[] };
      compatibility: unknown;
    }>(response);

    const ir = ResultViewIRSchema.parse(body.resultView);
    expect(ir.id).toBe(`result-view-${created.id}`);
    expect(ir.runId).toBe(created.id);
    expect(ir.version).toBe(1);
    expect(ir.blocks.map((block) => block.kind)).toEqual([
      'logs',
      'artifacts',
      'candidates',
      'metrics',
      'provenance',
      'widget',
      'widget',
      'widget',
    ]);
    expect(body.data.run.id).toBe(created.id);
    expect(body.data.artifacts).toHaveLength(5);
    expect(body.data.metrics).toHaveLength(5);

    const compatibility = ResultViewCompatibilityReportSchema.parse(body.compatibility);
    const evaluation = (blockId: string) =>
      compatibility.blocks.find((block) => block.blockId === blockId)!;

    expect(evaluation('logs')).toMatchObject({ status: 'compatible' });
    expect(evaluation('logs').taskIds).toHaveLength(3);
    expect(evaluation('artifacts').status).toBe('compatible');
    expect(evaluation('artifacts').artifactIds).toHaveLength(5);
    expect(evaluation('candidates').status).toBe('compatible');
    expect(evaluation('candidates').artifactIds).toEqual(
      expect.arrayContaining([
        detail.artifacts.find((artifact) => artifact.name === 'candidates.json')!.id,
        detail.artifacts.find((artifact) => artifact.name === 'candidates.fasta')!.id,
        detail.artifacts.find((artifact) => artifact.name === 'ranking.json')!.id,
      ]),
    );
    expect(evaluation('metrics').status).toBe('compatible');
    expect(evaluation('metrics').metricIds).toHaveLength(5);
    expect(evaluation('provenance').status).toBe('compatible');
    expect(evaluation('provenance').artifactIds).toHaveLength(5);

    expect(evaluation('widget-sflow.candidate-table')).toMatchObject({
      status: 'compatible',
      widgetId: 'sflow.candidate-table',
    });
    expect(evaluation('widget-sflow.candidate-table').artifactIds).toHaveLength(3);
    expect(evaluation('widget-sflow.metric-summary').status).toBe('compatible');
    // The deterministic path produced no predicted structures, so the
    // structure Widget has no compatible data and is omitted rather than
    // receiving unrelated Artifacts.
    expect(evaluation('widget-sflow.structure-viewer')).toMatchObject({
      status: 'empty',
      artifactIds: [],
    });
    expect(compatibility.rejected).toEqual([]);

    // The durable IR is stored independently of the response payload and
    // survives a Server restart unchanged.
    await handle!.close({ cleanupProject: false });
    handle = undefined;
    handle = await bootTestServer({ projectRoot: root });
    const accepted = await login(handle.url, handle.credential);
    const afterRestart = await readJson<{ resultView: unknown }>(
      await getJson(
        `${handle.url}/api/runs/${created.id}/result-view`,
        sessionCookie(accepted)!,
      ),
    );
    expect(afterRestart.resultView).toEqual(body.resultView);
  });

  it('downloads immutable Artifact bytes with the recorded media type and attachment filename', async () => {
    const { cookie, fileReference, root } = await boot();
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const created = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, created.id);
    expect(detail.run.status).toBe('completed');

    const jsonArtifact = detail.artifacts.find((artifact) => artifact.name === 'candidates.json')!;
    const fastaArtifact = detail.artifacts.find(
      (artifact) => artifact.name === 'candidates.fasta',
    )!;
    expect(jsonArtifact).toBeDefined();
    expect(fastaArtifact).toBeDefined();

    for (const artifact of [jsonArtifact, fastaArtifact]) {
      const downloads: Buffer[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await getJson(
          `${handle!.url}/api/runs/${created.id}/artifacts/${artifact.id}/download`,
          cookie,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(artifact.mediaType);
        expect(response.headers.get('content-disposition')).toContain('attachment');
        expect(response.headers.get('content-disposition')).toContain(
          `filename="${artifact.name}"`,
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.byteLength).toBe(artifact.size);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
        downloads.push(bytes);
      }
      // The recorded bytes never change between downloads.
      expect(downloads[0].equals(downloads[1])).toBe(true);
      expect(downloads[0].equals(readFileSync(join(root, artifact.path)))).toBe(true);
    }

    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/${created.id}/artifacts/${jsonArtifact.id}/download`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/${created.id}/artifacts/missing/download`,
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/missing/artifacts/${jsonArtifact.id}/download`,
          cookie,
        )
      ).status,
    ).toBe(404);

    // A Run never exposes another Run's Artifact, even with a valid id.
    const second = await startRun(cookie);
    const secondDetail = await waitForTerminal(handle!, cookie, second.id);
    expect(secondDetail.run.status).toBe('completed');
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/${second.id}/artifacts/${jsonArtifact.id}/download`,
          cookie,
        )
      ).status,
    ).toBe(404);
  });
});
