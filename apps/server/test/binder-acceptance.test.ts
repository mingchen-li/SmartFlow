import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BINDER_REQUIRED_OUTPUTS,
  CandidateSetSchema,
  ComparisonReportSchema,
  ResultViewResponseSchema,
  RunSnapshotSchema,
  validateWorkflow,
  type CandidateSet,
  type ComparisonReport,
  type CreateRunResponse,
  type FileReference,
  type Run,
  type RunDetailResponse,
  type RunEventsResponse,
  type TaskLogsResponse,
  type ValidateWorkflowResponse,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinManifests } from '@sflow/nodes';
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
 * Deterministic Binder acceptance harness (ticket #11).
 *
 * It exercises the complete standard Binder DAG through the real Project
 * Server and the local Compute Executor: validation, dependency-ordered Task
 * execution, logs, output Artifacts, Candidate/CandidateSet context, Metrics,
 * Provenance, Result View inspection, and byte-stable repeat Runs. No model
 * weights, scheduler, or external service is involved.
 */

function waitForTerminal(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
): Promise<RunDetailResponse> {
  const deadline = Date.now() + 15_000;
  return (async () => {
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
  })();
}

function artifactByName(detail: RunDetailResponse, name: string) {
  const artifact = detail.artifacts.find((candidate) => candidate.name === name);
  expect(artifact, `Missing Artifact ${name}`).toBeDefined();
  return artifact!;
}

describe('Deterministic Binder acceptance path', () => {
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
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-binder-acceptance-'));
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
    return {
      cookie,
      fileReference: await readJson<FileReference>(registered),
      root: projectRoot,
    };
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

  it('runs the complete production-shaped Binder DAG and makes every step inspectable', async () => {
    const { cookie, fileReference, root } = await boot();
    const workflow = buildWorkflow(fileReference);
    await saveWorkflow(cookie, workflow);

    // The standard DAG validates against the installed production-shaped
    // Manifests, including the required Binder outputs.
    const validation = await readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation).toEqual({ valid: true, diagnostics: [] });
    expect(validateWorkflow(workflow, builtinManifests, {
      requiredOutputs: BINDER_REQUIRED_OUTPUTS,
    })).toEqual({ valid: true, diagnostics: [] });

    const created = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, created.id);
    expect(detail.run.status).toBe('completed');
    expect(detail.tasks).toHaveLength(5);
    expect(detail.tasks.map((task) => task.nodeId)).toEqual([
      NODE_IDS.target,
      NODE_IDS.generator,
      NODE_IDS.designer,
      NODE_IDS.predictor,
      NODE_IDS.comparison,
    ]);
    for (const task of detail.tasks) {
      expect(task.state).toBe('completed');
      expect(task.attempt).toBe(1);
      expect(task.exitCode).toBe(0);
      expect(task.logsAvailable).toBe(true);
      expect(task.jobId).toMatch(/^job-/);
    }

    // The immutable snapshot records the complete Manifest contract.
    const snapshot = RunSnapshotSchema.parse(detail.run.snapshot);
    expect(snapshot.workflow).toEqual(workflow);
    for (const node of snapshot.nodes) {
      expect(node.manifestVersion).toBe('1.0.0');
      expect(node.environment).toMatchObject({ kind: 'container' });
      expect(node.environment.image).toContain(node.manifestId);
      expect(node.resources.cpu).toBeGreaterThan(0);
      expect(node.retry.maxAttempts).toBeGreaterThanOrEqual(1);
    }

    // Dependency ordering is observable in the append-only event stream:
    // every source Task completes before its downstream Task starts.
    const { events } = await readJson<RunEventsResponse>(
      await getJson(`${handle!.url}/api/runs/${created.id}/events`, cookie),
    );
    const taskByNode = new Map(detail.tasks.map((task) => [task.nodeId, task]));
    const firstEvent = (taskId: string, type: string): number | undefined =>
      events.find((event) => event.taskId === taskId && event.type === type)?.id;
    let checkedEdges = 0;
    for (const edge of workflow.edges) {
      const source = taskByNode.get(edge.source)!;
      const target = taskByNode.get(edge.target)!;
      const sourceCompleted = firstEvent(source.id, 'task.completed');
      const targetRunning = firstEvent(target.id, 'task.running');
      expect(sourceCompleted, `Missing completion for ${edge.source}`).toBeDefined();
      expect(targetRunning, `Missing start for ${edge.target}`).toBeDefined();
      expect(sourceCompleted!).toBeLessThan(targetRunning!);
      checkedEdges += 1;
    }
    expect(checkedEdges).toBe(8);

    // Each Task owns line-oriented logs from the local executor.
    for (const task of detail.tasks) {
      const logs = await readJson<TaskLogsResponse>(
        await getJson(
          `${handle!.url}/api/runs/${created.id}/tasks/${task.id}/logs`,
          cookie,
        ),
      );
      expect(logs.available).toBe(true);
      expect(logs.logsPath).toBe(
        `.sflow/runs/${created.id}/tasks/${task.id}/logs.txt`,
      );
      expect(logs.lines).toEqual(
        expect.arrayContaining([
          `node=${task.manifestId} attempt=1`,
          'state=running',
          'state=completed',
        ]),
      );
    }
    const targetTask = taskByNode.get(NODE_IDS.target)!;
    const targetLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${created.id}/tasks/${targetTask.id}/logs`,
        cookie,
      ),
    );
    expect(targetLogs.lines).toContain('loaded target.path=targets/target.pdb');
    expect(targetLogs.lines).toContain('loaded target.residues=2');

    // Exactly the expected output files exist, are content-addressed, and
    // carry Provenance back to their Task attempt and upstream Artifacts.
    expect(detail.artifacts.map((artifact) => artifact.name).sort()).toEqual(
      [
        'candidates.fasta',
        'candidates.json',
        'design-0001.pdb',
        'design-0002.pdb',
        'design-0003.pdb',
        'designs.fasta',
        'designs.json',
        'ranking.json',
        'report.json',
        'scored.json',
        'scores.csv',
        'target.json',
      ].sort(),
    );
    for (const artifact of detail.artifacts) {
      const bytes = readFileSync(join(root, artifact.path));
      expect(artifact.size).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(artifact.provenance).toMatchObject({
        runId: created.id,
        taskId: artifact.taskId,
        nodeId: artifact.nodeId,
        attempt: 1,
        manifestId: taskByNode.get(artifact.nodeId)!.manifestId,
        manifestVersion: '1.0.0',
        executor: { kind: 'local', jobId: taskByNode.get(artifact.nodeId)!.jobId },
      });
    }

    const readSet = (name: string): CandidateSet => {
      const artifact = artifactByName(detail, name);
      expect(artifact.schema).toEqual({
        namespace: 'sflow.binder',
        name: 'candidate-set',
        version: '1.0.0',
      });
      return CandidateSetSchema.parse(
        JSON.parse(readFileSync(join(root, artifact.path), 'utf8')),
      );
    };
    const candidates = readSet('candidates.json');
    const designs = readSet('designs.json');
    const scored = readSet('scored.json');
    const ranking = readSet('ranking.json');

    // CandidateSet context is explicit and chains each derived set to its
    // source, so generation/design/prediction/ranking contexts never merge.
    expect(candidates.context).toEqual({
      strategy: 'cdr-focused',
      seed: 42,
      parameters: { numCandidates: 5, useTargetHotspots: true },
    });
    expect(candidates.candidates).toHaveLength(5);
    expect(candidates.candidates.map((candidate) => candidate.id)).toEqual([
      'candidate-0001',
      'candidate-0002',
      'candidate-0003',
      'candidate-0004',
      'candidate-0005',
    ]);
    expect(new Set(candidates.candidates.map((candidate) => candidate.sequence)).size).toBe(5);
    expect(candidates.scores).toEqual([]);

    expect(designs.context).toEqual({
      strategy: 'vhh-designer-v1',
      seed: 7,
      model: 'vhh-designer-v1',
      sourceCandidateSetId: candidates.id,
      parameters: { temperature: 0.7, trimTerminalTags: true },
    });
    expect(designs.candidates).toHaveLength(3);
    expect(
      designs.candidates.every((candidate) =>
        candidates.candidates.some((parent) => parent.id === candidate.parentId),
      ),
    ).toBe(true);
    expect(designs.scores.map((score) => score.metricId)).toEqual([
      'sequence-confidence',
      'sequence-confidence',
      'sequence-confidence',
    ]);

    expect(scored.context).toEqual({
      strategy: 'structure-prediction',
      seed: 1,
      model: 'esmfold2',
      sourceCandidateSetId: designs.id,
      parameters: { recycles: 3, batchSize: 4 },
    });
    expect(scored.candidates).toHaveLength(3);
    expect(scored.scores).toHaveLength(6);
    expect(new Set(scored.scores.map((score) => score.metricId))).toEqual(
      new Set(['plddt', 'iptm']),
    );

    expect(ranking.context).toEqual({
      strategy: 'candidate-comparison',
      label: 'round-1',
      sourceCandidateSetId: scored.id,
      parameters: { rankingMetric: 'plddt', topN: 2, deduplicate: true },
    });
    expect(ranking.candidates).toHaveLength(2);
    const scoredPlddt = scored.scores
      .filter((score) => score.metricId === 'plddt')
      .sort((left, right) => right.value - left.value);
    expect(ranking.candidates.map((candidate) => candidate.id)).toEqual(
      scoredPlddt.slice(0, 2).map((score) => score.candidateId),
    );

    const report = ComparisonReportSchema.parse(
      JSON.parse(
        readFileSync(join(root, artifactByName(detail, 'report.json').path), 'utf8'),
      ),
    ) as ComparisonReport;
    expect(report).toMatchObject({
      label: 'round-1',
      rankingMetric: 'plddt',
      candidateCount: 3,
      selectedCount: 2,
      bestScore: scoredPlddt[0]!.value,
    });
    expect(report.entries.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(report.entries.map((entry) => entry.score)).toEqual(
      scoredPlddt.slice(0, 2).map((score) => score.value),
    );

    // Typed Metrics retain meaning, scale, namespaced schema, and Provenance.
    expect(detail.metrics.map((metric) => metric.metricId).sort()).toEqual(
      [
        'bestPlddt',
        'candidateCount',
        'designCount',
        'meanConfidence',
        'meanIptm',
        'meanPlddt',
        'scoredCount',
        'selectedCount',
        'targetResidueCount',
        'uniqueCandidates',
      ].sort(),
    );
    const metric = (metricId: string) =>
      detail.metrics.find((candidate) => candidate.metricId === metricId)!;
    expect(metric('targetResidueCount').value).toBe(2);
    expect(metric('candidateCount').value).toBe(5);
    expect(metric('uniqueCandidates').value).toBe(5);
    expect(metric('designCount').value).toBe(3);
    expect(metric('scoredCount').value).toBe(3);
    expect(metric('selectedCount').value).toBe(2);
    expect(metric('meanConfidence')).toMatchObject({
      valueType: 'number',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      schema: {
        namespace: 'sflow.binder.sequence-design',
        name: 'meanConfidence',
        version: '1.0.0',
      },
    });
    expect(metric('meanPlddt')).toMatchObject({
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 100 },
      direction: 'higher-is-better',
      schema: {
        namespace: 'sflow.binder.structure-prediction',
        name: 'meanPlddt',
        version: '1.0.0',
      },
    });
    expect(metric('bestPlddt').value).toBe(report.bestScore);
    for (const item of detail.metrics) {
      expect(item.provenance).toMatchObject({
        runId: created.id,
        taskId: item.taskId,
        nodeId: item.nodeId,
        executor: { kind: 'local', jobId: taskByNode.get(item.nodeId)!.jobId },
        environment: { kind: 'container' },
      });
    }

    // Provenance links downstream Artifacts and Metrics to upstream outputs.
    const upstreamIds = (nodeId: string): string[] =>
      detail.artifacts
        .filter((artifact) => artifact.nodeId === nodeId)
        .map((artifact) => artifact.id)
        .sort();
    expect(artifactByName(detail, 'candidates.json').provenance.inputs.artifacts).toEqual(
      upstreamIds(NODE_IDS.target),
    );
    expect(artifactByName(detail, 'designs.json').provenance.inputs.artifacts).toEqual(
      upstreamIds(NODE_IDS.generator),
    );
    expect(artifactByName(detail, 'scored.json').provenance.inputs.artifacts).toEqual(
      upstreamIds(NODE_IDS.designer),
    );
    expect(artifactByName(detail, 'ranking.json').provenance.inputs.artifacts).toEqual(
      upstreamIds(NODE_IDS.predictor),
    );
    expect(metric('meanPlddt').provenance.inputs.artifacts).toEqual(
      upstreamIds(NODE_IDS.designer),
    );

    // Result View inspection resolves every block and Widget against the full
    // 5-Task Run without rejection or coercion.
    const parsed = ResultViewResponseSchema.parse(
      await readJson(
        await getJson(`${handle!.url}/api/runs/${created.id}/result-view`, cookie),
      ),
    );
    expect(parsed.resultView.blocks.map((block) => block.kind)).toEqual([
      'logs',
      'artifacts',
      'candidates',
      'metrics',
      'provenance',
      'widget',
      'widget',
      'widget',
    ]);
    expect(parsed.compatibility.rejected).toEqual([]);
    expect(parsed.data.tasks).toHaveLength(5);
    expect(parsed.data.artifacts).toHaveLength(12);
    expect(parsed.data.metrics).toHaveLength(10);
    const evaluation = (blockId: string) =>
      parsed.compatibility.blocks.find((block) => block.blockId === blockId)!;

    expect(evaluation('logs')).toMatchObject({ status: 'compatible' });
    expect(evaluation('logs').taskIds).toHaveLength(5);
    expect(evaluation('artifacts').status).toBe('compatible');
    expect(evaluation('artifacts').artifactIds).toHaveLength(12);
    expect(evaluation('candidates')).toMatchObject({
      status: 'compatible',
      artifactIds: expect.arrayContaining([
        artifactByName(detail, 'candidates.json').id,
        artifactByName(detail, 'designs.json').id,
        artifactByName(detail, 'scored.json').id,
        artifactByName(detail, 'ranking.json').id,
      ]),
    });
    expect(evaluation('candidates').artifactIds).toHaveLength(7);
    expect(evaluation('metrics').status).toBe('compatible');
    expect(evaluation('metrics').metricIds).toHaveLength(10);
    expect(evaluation('provenance').status).toBe('compatible');
    expect(evaluation('provenance').artifactIds).toHaveLength(12);
    expect(evaluation('provenance').metricIds).toHaveLength(10);
    expect(evaluation('provenance').taskIds).toHaveLength(5);
    expect(evaluation('widget-sflow.candidate-table')).toMatchObject({
      status: 'compatible',
      widgetId: 'sflow.candidate-table',
    });
    expect(evaluation('widget-sflow.candidate-table').artifactIds).toHaveLength(7);
    expect(evaluation('widget-sflow.metric-summary')).toMatchObject({
      status: 'compatible',
    });
    expect(evaluation('widget-sflow.metric-summary').metricIds).toHaveLength(4);
    // The complete path now produces predicted structures for the viewer.
    expect(evaluation('widget-sflow.structure-viewer')).toMatchObject({
      status: 'compatible',
      widgetId: 'sflow.structure-viewer',
    });
    expect(evaluation('widget-sflow.structure-viewer').artifactIds).toHaveLength(3);

    // The same snapshot produces byte-identical Artifacts and identical
    // scientific Metric values: no model weights or score variance.
    const second = await startRun(cookie);
    const secondDetail = await waitForTerminal(handle!, cookie, second.id);
    expect(secondDetail.run.status).toBe('completed');
    expect(secondDetail.run.snapshot).toEqual(detail.run.snapshot);

    const digests = (runDetail: RunDetailResponse): Record<string, string> =>
      Object.fromEntries(
        runDetail.artifacts.map((artifact) => [
          `${artifact.nodeId}/${artifact.name}`,
          artifact.sha256,
        ]),
      );
    expect(digests(secondDetail)).toEqual(digests(detail));

    const metricValues = (runDetail: RunDetailResponse): Record<string, unknown> =>
      Object.fromEntries(
        runDetail.metrics.map((item) => [
          `${item.nodeId}/${item.metricId}`,
          item.value,
        ]),
      );
    expect(metricValues(secondDetail)).toEqual(metricValues(detail));
    expect(secondDetail.tasks.every((task) => task.jobId?.startsWith('job-'))).toBe(true);
  });
});
