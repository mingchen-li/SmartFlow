import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CandidateSetSchema,
  ComparisonReportSchema,
  ResultViewResponseSchema,
  RunSnapshotSchema,
  type CreateRunResponse,
  type FileReference,
  type NodeImplementation,
  type NodeRegistry,
  type Run,
  type RunDetailResponse,
  type TaskLogsResponse,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinNodeImplementation, builtinNodeImplementations } from '@sflow/nodes';
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
import {
  DRAFT_ID,
  NODE_IDS,
  TARGET_PDB,
  buildWorkflow,
  emptyLayout,
} from './workflow-fixture';

/**
 * Node implementations are resolved through the registry at execution time.
 * These tests replace each built-in deterministic Node behind the same
 * Manifest, and then replace a Node with a new Manifest version, without
 * changing Workflow IR, Run snapshot, Artifact/Metric, or Result View
 * contracts.
 */

function markerImplementation(
  implementation: NodeImplementation,
  marker: string,
): NodeImplementation {
  return {
    manifest: implementation.manifest,
    run: async (input, parameters, context) => {
      context.log(`implementation=${marker}:${implementation.manifest.id}`);
      return implementation.run(input, parameters, context);
    },
  };
}

function registryOf(implementations: readonly NodeImplementation[]): NodeRegistry {
  return {
    get: (manifestId, manifestVersion) =>
      implementations.find(
        (implementation) =>
          implementation.manifest.id === manifestId &&
          implementation.manifest.version === manifestVersion,
      ),
    list: () => implementations,
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

describe('Node implementation replaceability', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(
    registry: NodeRegistry,
  ): Promise<{ cookie: string; fileReference: FileReference }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-replaceability-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);

    handle = await bootTestServer({ projectRoot, registry });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;
    const registered = await postJson(
      `${handle.url}/api/files`,
      { path: 'targets/target.pdb' },
      cookie,
    );
    expect(registered.status).toBe(200);
    return { cookie, fileReference: await readJson<FileReference>(registered) };
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

  async function expectArtifactContracts(
    cookie: string,
    detail: RunDetailResponse,
  ): Promise<void> {
    const byName = (name: string) => {
      const artifact = detail.artifacts.find((candidate) => candidate.name === name);
      expect(artifact, `Missing Artifact ${name}`).toBeDefined();
      return artifact!;
    };

    for (const name of [
      'candidates.json',
      'designs.json',
      'scored.json',
      'ranking.json',
    ]) {
      const artifact = byName(name);
      expect(artifact.schema).toEqual({
        namespace: 'sflow.binder',
        name: 'candidate-set',
        version: '1.0.0',
      });
      const response = await getJson(
        `${handle!.url}/api/runs/${detail.run.id}/artifacts/${artifact.id}/download`,
        cookie,
      );
      expect(response.status).toBe(200);
      CandidateSetSchema.parse(await response.json());
    }

    expect(byName('report.json').schema).toEqual({
      namespace: 'sflow.binder',
      name: 'comparison-report',
      version: '1.0.0',
    });
    const report = await readJson<unknown>(
      await getJson(
        `${handle!.url}/api/runs/${detail.run.id}/artifacts/${byName('report.json').id}/download`,
        cookie,
      ),
    );
    ComparisonReportSchema.parse(report);
  }

  it('executes the complete Binder DAG with every deterministic Node replaced through the registry', async () => {
    const implementations = builtinNodeImplementations.map((implementation) =>
      markerImplementation(implementation, 'alternate'),
    );
    const { cookie, fileReference } = await boot(registryOf(implementations));

    const workflow = buildWorkflow(fileReference);
    await saveWorkflow(cookie, workflow);

    // The Node catalog and validation both come from the installed registry.
    const catalog = await readJson<{ nodes: Array<{ id: string; version: string }> }>(
      await getJson(`${handle!.url}/api/nodes`, cookie),
    );
    expect(catalog.nodes.map((node) => node.id)).toEqual([
      'target-input',
      'candidate-generation',
      'sequence-design',
      'structure-prediction',
      'candidate-comparison',
    ]);

    const validation = await readJson<{ valid: boolean }>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation.valid).toBe(true);

    const run = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('completed');
    expect(detail.tasks).toHaveLength(5);

    for (const task of detail.tasks) {
      const logs = await readJson<TaskLogsResponse>(
        await getJson(
          `${handle!.url}/api/runs/${run.id}/tasks/${task.id}/logs`,
          cookie,
        ),
      );
      expect(logs.lines).toContain(`implementation=alternate:${task.manifestId}`);
      expect(logs.lines).toContain('state=completed');
    }

    // The replaced implementations still satisfy the exact Run snapshot,
    // Artifact, Metric, and Result View contracts.
    expect(RunSnapshotSchema.parse(detail.run.snapshot)).toEqual(detail.run.snapshot);
    expect(detail.run.snapshot.nodes.map((node) => node.manifestVersion)).toEqual([
      '1.0.0',
      '1.0.0',
      '1.0.0',
      '1.0.0',
      '1.0.0',
    ]);
    expect(detail.artifacts).toHaveLength(12);
    expect(detail.metrics).toHaveLength(10);
    await expectArtifactContracts(cookie, detail);

    const resultView = await readJson<unknown>(
      await getJson(`${handle!.url}/api/runs/${run.id}/result-view`, cookie),
    );
    const parsed = ResultViewResponseSchema.parse(resultView);
    expect(parsed.compatibility.rejected).toEqual([]);
    expect(parsed.compatibility.accepted).toEqual(
      expect.arrayContaining(['logs', 'artifacts', 'candidates', 'metrics', 'provenance']),
    );
    expect(parsed.data.artifacts).toHaveLength(12);
    expect(parsed.data.metrics).toHaveLength(10);

    // Replacing implementations did not rewrite the draft.
    const draft = await readJson<{ workflow: WorkflowIR }>(
      await getJson(`${handle!.url}/api/workflows/${DRAFT_ID}`, cookie),
    );
    expect(draft.workflow).toEqual(workflow);
  });

  it('swaps a Node to a new Manifest version without changing execution or Result View contracts', async () => {
    const base = builtinNodeImplementation('candidate-generation', '1.0.0')!;
    const nextVersion: NodeImplementation = {
      manifest: { ...base.manifest, version: '1.1.0' },
      run: markerImplementation(base, 'version-1.1.0').run,
    };
    const { cookie, fileReference } = await boot(
      registryOf([...builtinNodeImplementations, nextVersion]),
    );

    const workflow = buildWorkflow(fileReference);
    const generator = workflow.nodes.find((node) => node.id === NODE_IDS.generator)!;
    generator.manifestVersion = '1.1.0';
    await saveWorkflow(cookie, workflow);

    const validation = await readJson<{ valid: boolean; diagnostics: unknown[] }>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation).toEqual({ valid: true, diagnostics: [] });

    const run = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('completed');

    // The snapshot pins the new version while keeping the strict Run contract.
    const snapshot = RunSnapshotSchema.parse(detail.run.snapshot);
    expect(
      snapshot.nodes.find((node) => node.nodeId === NODE_IDS.generator)?.manifestVersion,
    ).toBe('1.1.0');
    expect(snapshot.workflow.nodes.find((node) => node.id === NODE_IDS.generator))
      .toMatchObject({ manifestId: 'candidate-generation', manifestVersion: '1.1.0' });

    const generatorTask = detail.tasks.find(
      (task) => task.nodeId === NODE_IDS.generator,
    )!;
    expect(generatorTask.manifestVersion).toBe('1.1.0');
    const logs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${run.id}/tasks/${generatorTask.id}/logs`,
        cookie,
      ),
    );
    expect(logs.lines).toContain('implementation=version-1.1.0:candidate-generation');

    // Version 1.1.0 still emits the candidate-set Artifact schema and the
    // generic Metric contract, so no Result View binding changes.
    await expectArtifactContracts(cookie, detail);
    const candidateCount = detail.metrics.find(
      (metric) => metric.metricId === 'candidateCount',
    )!;
    expect(candidateCount.schema).toEqual({
      namespace: 'sflow.binder.candidate-generation',
      name: 'candidateCount',
      version: '1.1.0',
    });
    expect(candidateCount.value).toBe(5);

    const parsed = ResultViewResponseSchema.parse(
      await readJson(
        await getJson(`${handle!.url}/api/runs/${run.id}/result-view`, cookie),
      ),
    );
    expect(parsed.compatibility.rejected).toEqual([]);
    const candidateWidget = parsed.compatibility.blocks.find(
      (block) => block.blockId === 'widget-sflow.candidate-table',
    );
    expect(candidateWidget).toMatchObject({ status: 'compatible' });
    expect(candidateWidget!.artifactIds).toHaveLength(7);

    // The Workflow IR contract is unchanged: same strict shape, one version
    // string advanced, layout state still absent.
    expect(Object.keys(workflow).sort()).toEqual(['edges', 'id', 'name', 'nodes', 'version']);
    const draft = await readJson<{ workflow: WorkflowIR }>(
      await getJson(`${handle!.url}/api/workflows/${DRAFT_ID}`, cookie),
    );
    expect(draft.workflow).toEqual(workflow);
  });
});
