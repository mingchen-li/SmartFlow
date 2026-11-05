import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResultViewResponseSchema,
  RunSnapshotSchema,
  type CreateRunResponse,
  type FileReference,
  type NodeImplementation,
  type ResultViewResponse,
  type Run,
  type RunDetailResponse,
  type TaskLogsResponse,
  type ValidateWorkflowResponse,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinNodeImplementations } from '@sflow/nodes';
import {
  productionStructurePredictionImplementation,
  runProductionStructurePredictionContainer,
  STRUCTURE_PREDICTION_PRODUCTION_COMMAND,
  STRUCTURE_PREDICTION_PRODUCTION_IMAGE,
} from '@sflow/nodes-structure-prediction';
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
import { SimulatedSlurmScheduler } from './production-slurm';

/**
 * Production Binder Node replacement seam (ticket #13).
 *
 * One deterministic Binder Node — structure prediction — is replaced by a
 * separately packaged, versioned production Manifest. The Server catalog,
 * Workflow validation, and Run snapshot resolve it through the same registry
 * seam; the Orchestrator runs it through the Slurm Compute Executor. The
 * scheduler is a fake CommandRunner that executes the production container
 * entrypoint in-process and writes ticket #12's `result.json` protocol, so no
 * Slurm, Docker, network, or model weights are required.
 */

const PREDICTION_KEY = 'structure-prediction@2.0.0';
const NEXT_PREDICTION_VERSION = '3.0.0';

function waitForTerminal(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
): Promise<RunDetailResponse> {
  const deadline = Date.now() + 20_000;
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

function productionWorkflow(fileReference: FileReference, version = '2.0.0'): WorkflowIR {
  const workflow = buildWorkflow(fileReference);
  const predictor = workflow.nodes.find((node) => node.id === NODE_IDS.predictor)!;
  predictor.manifestVersion = version;
  return workflow;
}

function taskByNode(detail: RunDetailResponse, nodeId: string) {
  const task = detail.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(task, `Missing Task for ${nodeId}`).toBeDefined();
  return task!;
}

function artifactContract(detail: RunDetailResponse) {
  return detail.artifacts
    .map((artifact) => ({
      nodeId: artifact.nodeId,
      name: artifact.name,
      mediaType: artifact.mediaType,
      schema: artifact.schema,
    }))
    .sort((left, right) =>
      `${left.nodeId}/${left.name}`.localeCompare(`${right.nodeId}/${right.name}`),
    );
}

function artifactDigests(detail: RunDetailResponse): Record<string, string> {
  return Object.fromEntries(
    detail.artifacts.map((artifact) => [
      `${artifact.nodeId}/${artifact.name}`,
      artifact.sha256,
    ]),
  );
}

/**
 * `target.json` projects the Project-local File Reference identity into its
 * content (`target.id` and `source.fileReferenceId`). Two Projects record
 * different ids by design, so its bytes are compared with that identity
 * normalized rather than by stored digest.
 */
async function targetArtifactContent(
  handle: TestServerHandle,
  cookie: string,
  detail: RunDetailResponse,
  fileReferenceId: string,
): Promise<unknown> {
  const artifact = detail.artifacts.find(
    (candidate) =>
      candidate.nodeId === NODE_IDS.target && candidate.name === 'target.json',
  );
  expect(artifact, 'Missing target.json Artifact').toBeDefined();
  const response = await getJson(
    `${handle.url}/api/runs/${detail.run.id}/artifacts/${artifact!.id}/download`,
    cookie,
  );
  expect(response.status).toBe(200);
  return JSON.parse(
    (await response.text()).replaceAll(fileReferenceId, '<file-reference>'),
  );
}

function withoutTargetArtifactDigest(
  digests: Record<string, string>,
): Record<string, string> {
  const { [`${NODE_IDS.target}/target.json`]: _target, ...rest } = digests;
  return rest;
}

function metricContract(detail: RunDetailResponse) {
  return detail.metrics
    .map((metric) => ({
      nodeId: metric.nodeId,
      metricId: metric.metricId,
      name: metric.name,
      valueType: metric.valueType,
      value: metric.value,
      unit: metric.unit,
      scale: metric.scale,
      direction: metric.direction,
      schemaNamespace: metric.schema.namespace,
      schemaName: metric.schema.name,
    }))
    .sort((left, right) =>
      `${left.nodeId}/${left.metricId}`.localeCompare(`${right.nodeId}/${right.metricId}`),
    );
}

function metricSchemaVersions(detail: RunDetailResponse): Record<string, string> {
  return Object.fromEntries(
    detail.metrics.map((metric) => [
      `${metric.nodeId}/${metric.metricId}`,
      metric.schema.version,
    ]),
  );
}

/** File References are Project-local; compare their contract shape, not ids. */
function normalizeFileReferences(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const clone = structuredClone(parameters);
  for (const value of Object.values(clone)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      'fileReferenceId' in value
    ) {
      (value as { fileReferenceId: unknown }).fileReferenceId = '<file-reference>';
    }
  }
  return clone;
}

/**
 * Result View IR is Run-scoped, so the identity fields are normalized before
 * comparing the durable presentation contract across implementations.
 */
function durableResultView(response: ResultViewResponse) {
  return {
    resultView: {
      ...structuredClone(response.resultView),
      id: '<run-view>',
      runId: '<run>',
      createdAt: '<created>',
    },
    accepted: [...response.compatibility.accepted].sort(),
    rejected: response.compatibility.rejected,
  };
}

describe('Production Binder Node replacement through Slurm', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(options: {
    executor: 'local' | 'slurm';
    scheduler?: SimulatedSlurmScheduler;
    implementations?: readonly NodeImplementation[];
  }): Promise<{
    cookie: string;
    fileReference: FileReference;
    root: string;
    scheduler?: SimulatedSlurmScheduler;
  }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-production-node-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);

    const scheduler =
      options.scheduler ??
      (options.executor === 'slurm'
        ? new SimulatedSlurmScheduler({
            projectRoot,
            implementations: [
              ...builtinNodeImplementations,
              ...(options.implementations ?? []),
            ],
            containerEntrypoints: {
              [PREDICTION_KEY]: runProductionStructurePredictionContainer,
            },
          })
        : undefined);

    handle = await bootTestServer({
      projectRoot,
      ...(options.executor === 'slurm'
        ? { executor: 'slurm' as const, commandRunner: scheduler! }
        : { executor: 'local' as const }),
      ...(options.implementations
        ? { nodeImplementations: options.implementations }
        : {}),
    });
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
      ...(scheduler ? { scheduler } : {}),
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

  async function validate(
    cookie: string,
  ): Promise<ValidateWorkflowResponse> {
    return readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
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

  async function runToTerminal(cookie: string): Promise<RunDetailResponse> {
    const run = await startRun(cookie);
    return waitForTerminal(handle!, cookie, run.id);
  }

  async function resultView(cookie: string, runId: string): Promise<ResultViewResponse> {
    return ResultViewResponseSchema.parse(
      await readJson(
        await getJson(`${handle!.url}/api/runs/${runId}/result-view`, cookie),
      ),
    );
  }

  it('runs the production structure predictor through Slurm while keeping Workflow, Run, scientific, and Result View contracts stable', async () => {
    // Deterministic fixture run (local executor) used as the contract baseline.
    const fixture = await boot({ executor: 'local' });
    const fixtureWorkflow = buildWorkflow(fixture.fileReference);
    await saveWorkflow(fixture.cookie, fixtureWorkflow);
    expect(await validate(fixture.cookie)).toEqual({ valid: true, diagnostics: [] });
    const fixtureDetail = await runToTerminal(fixture.cookie);
    expect(fixtureDetail.run.status).toBe('completed');
    const fixtureView = await resultView(fixture.cookie, fixtureDetail.run.id);
    const fixtureDigests = artifactDigests(fixtureDetail);
    const fixtureMetrics = metricContract(fixtureDetail);
    const fixtureTarget = await targetArtifactContent(
      handle!,
      fixture.cookie,
      fixtureDetail,
      fixture.fileReference.id,
    );

    const fixtureRoot = fixture.root;
    await handle!.close({ cleanupProject: false });
    handle = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
    projectRoot = undefined;

    // Production run: same Workflow IR shape, predictor pinned to 2.0.0, and
    // every Task executed by the Slurm Compute Executor.
    const productionImplementations = [productionStructurePredictionImplementation];
    const production = await boot({
      executor: 'slurm',
      implementations: productionImplementations,
    });
    const scheduler = production.scheduler!;
    const workflow = productionWorkflow(production.fileReference);
    await saveWorkflow(production.cookie, workflow);

    const catalog = await readJson<{ nodes: Array<{ id: string; version: string }> }>(
      await getJson(`${handle!.url}/api/nodes`, production.cookie),
    );
    expect(
      catalog.nodes
        .filter((node) => node.id === 'structure-prediction')
        .map((node) => node.version)
        .sort(),
    ).toEqual(['1.0.0', '2.0.0']);
    expect(await validate(production.cookie)).toEqual({ valid: true, diagnostics: [] });

    const productionDetail = await runToTerminal(production.cookie);
    expect(productionDetail.run.status).toBe('completed');
    expect(productionDetail.tasks).toHaveLength(5);
    for (const task of productionDetail.tasks) {
      expect(task.state).toBe('completed');
      expect(task.jobId).toMatch(/^\d+$/);
    }

    // The predictor Task and every scientific record name the production
    // Manifest version and the Slurm executor.
    const predictorTask = taskByNode(productionDetail, NODE_IDS.predictor);
    expect(predictorTask).toMatchObject({
      manifestId: 'structure-prediction',
      manifestVersion: '2.0.0',
    });
    for (const artifact of productionDetail.artifacts) {
      expect(artifact.provenance.executor.kind).toBe('slurm');
      expect(artifact.provenance.manifestVersion).toBe(
        artifact.nodeId === NODE_IDS.predictor ? '2.0.0' : '1.0.0',
      );
    }
    for (const metric of productionDetail.metrics) {
      expect(metric.provenance.executor.kind).toBe('slurm');
      expect(metric.provenance.manifestVersion).toBe(
        metric.nodeId === NODE_IDS.predictor ? '2.0.0' : '1.0.0',
      );
    }

    // The Slurm Job really carried the production OCI environment and the
    // executor's Task input contract.
    const submission = scheduler.submissions.find(
      (candidate) => `${candidate.input.manifestId}@${candidate.input.manifestVersion}` === PREDICTION_KEY,
    )!;
    expect(submission.script).toContain(STRUCTURE_PREDICTION_PRODUCTION_IMAGE);
    for (const argument of STRUCTURE_PREDICTION_PRODUCTION_COMMAND) {
      expect(submission.script).toContain(`'${argument}'`);
    }
    const persistedInput = JSON.parse(
      readFileSync(join(submission.taskDir, 'task-input.json'), 'utf8'),
    );
    expect(persistedInput).toMatchObject({
      manifestId: 'structure-prediction',
      manifestVersion: '2.0.0',
      parameters: expect.objectContaining({ predictor: 'esmfold2', seed: 1 }),
      inputs: expect.objectContaining({ designs: expect.any(Object) }),
    });

    const predictorLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${productionDetail.run.id}/tasks/${predictorTask.id}/logs`,
        production.cookie,
      ),
    );
    expect(predictorLogs.available).toBe(true);
    expect(predictorLogs.lines).toEqual(
      expect.arrayContaining([
        'structure-prediction-production manifest=structure-prediction@2.0.0',
        'structure-prediction-production scored=3 predictor=esmfold2',
      ]),
    );

    // Workflow IR: only the selected Node's Manifest version changes; the IR
    // schema and every other node/edge stay byte-identical.
    const productionDraft = await readJson<{ workflow: WorkflowIR }>(
      await getJson(`${handle!.url}/api/workflows/${DRAFT_ID}`, production.cookie),
    );
    expect(productionDraft.workflow).toEqual(workflow);
    const workflowAtFixtureVersion = structuredClone(workflow);
    workflowAtFixtureVersion.nodes.find(
      (node) => node.id === NODE_IDS.predictor,
    )!.manifestVersion = '1.0.0';
    expect(workflowAtFixtureVersion).toEqual(
      buildWorkflow(production.fileReference),
    );

    // Run snapshot: strict shape, same parameters/resources/retry contract,
    // and the production environment captured immutably for the predictor.
    const snapshot = RunSnapshotSchema.parse(productionDetail.run.snapshot);
    expect(snapshot.nodes.map((node) => node.manifestVersion)).toEqual([
      '1.0.0',
      '1.0.0',
      '1.0.0',
      '2.0.0',
      '1.0.0',
    ]);
    const fixtureSnapshot = RunSnapshotSchema.parse(fixtureDetail.run.snapshot);
    for (const node of snapshot.nodes) {
      const baseline = fixtureSnapshot.nodes.find(
        (candidate) => candidate.nodeId === node.nodeId,
      )!;
      expect(normalizeFileReferences(node.parameters)).toEqual(
        normalizeFileReferences(baseline.parameters),
      );
      expect(node.resources).toEqual(baseline.resources);
      expect(node.retry).toEqual(baseline.retry);
      if (node.nodeId !== NODE_IDS.predictor) {
        expect(node.environment).toEqual(baseline.environment);
        expect(node.manifestVersion).toBe(baseline.manifestVersion);
      }
    }
    const predictorSnapshot = snapshot.nodes.find(
      (node) => node.nodeId === NODE_IDS.predictor,
    )!;
    expect(predictorSnapshot.environment).toEqual(
      productionStructurePredictionImplementation.manifest.environment,
    );
    expect(predictorSnapshot.environment.image).toBe(
      STRUCTURE_PREDICTION_PRODUCTION_IMAGE,
    );

    // Artifact names, media types, and schema identities are unchanged; the
    // deterministic simulation also keeps content-addressed bytes stable. The
    // target Artifact is the sole exception: it embeds the Project-local File
    // Reference id, so its normalized content is compared instead.
    expect(artifactContract(productionDetail)).toEqual(
      artifactContract(fixtureDetail),
    );
    const productionDigests = withoutTargetArtifactDigest(
      artifactDigests(productionDetail),
    );
    expect(productionDigests).toEqual(withoutTargetArtifactDigest(fixtureDigests));
    expect(Object.keys(productionDigests)).toHaveLength(11);
    expect(
      await targetArtifactContent(
        handle!,
        production.cookie,
        productionDetail,
        production.fileReference.id,
      ),
    ).toEqual(fixtureTarget);
    expect(productionDetail.artifacts).toHaveLength(12);

    // Metric identities, meanings, values, units, scales, and directions are
    // unchanged. The schema version follows the replaced Manifest version.
    expect(metricContract(productionDetail)).toEqual(fixtureMetrics);
    const versions = metricSchemaVersions(productionDetail);
    const fixtureVersions = metricSchemaVersions(fixtureDetail);
    for (const key of Object.keys(fixtureVersions)) {
      expect(versions[key]).toBe(
        key.startsWith(`${NODE_IDS.predictor}/`) ? '2.0.0' : fixtureVersions[key],
      );
    }
    expect(productionDetail.metrics).toHaveLength(10);

    // Result View IR is unchanged for the replaced implementation.
    const productionView = await resultView(
      production.cookie,
      productionDetail.run.id,
    );
    expect(durableResultView(productionView)).toEqual(
      durableResultView(fixtureView),
    );
    expect(productionView.compatibility.rejected).toEqual([]);
    const evaluation = (blockId: string) =>
      productionView.compatibility.blocks.find((block) => block.blockId === blockId)!;
    expect(evaluation('widget-sflow.candidate-table')).toMatchObject({
      status: 'compatible',
    });
    expect(evaluation('widget-sflow.candidate-table').artifactIds).toHaveLength(7);
    expect(evaluation('widget-sflow.structure-viewer')).toMatchObject({
      status: 'compatible',
    });
    expect(evaluation('widget-sflow.structure-viewer').artifactIds).toHaveLength(3);
  });

  it('localizes a model container execution failure to the production Task and keeps other scientific records intact', async () => {
    const fixture = await boot({ executor: 'local' });
    await saveWorkflow(fixture.cookie, buildWorkflow(fixture.fileReference));
    const successfulBefore = await runToTerminal(fixture.cookie);
    expect(successfulBefore.run.status).toBe('completed');
    const fixtureRoot = fixture.root;
    await handle!.close({ cleanupProject: false });
    handle = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
    projectRoot = undefined;

    const production = await boot({
      executor: 'slurm',
      implementations: [productionStructurePredictionImplementation],
    });
    const scheduler = production.scheduler!;
    await saveWorkflow(
      production.cookie,
      productionWorkflow(production.fileReference),
    );

    const successful = await runToTerminal(production.cookie);
    expect(successful.run.status).toBe('completed');
    const recordsBefore = {
      artifacts: artifactDigests(successful),
      metrics: metricContract(successful),
    };

    scheduler.executionFailureFor = (manifestId, manifestVersion) =>
      `${manifestId}@${manifestVersion}` === PREDICTION_KEY
        ? `structure-prediction-production error: model checkpoint "/opt/sflow/models/structure-prediction-2.0.0.ckpt" is unavailable in the container image ${STRUCTURE_PREDICTION_PRODUCTION_IMAGE}`
        : undefined;

    const failed = await runToTerminal(production.cookie);
    expect(failed.run.status).toBe('failed');
    expect(failed.tasks).toHaveLength(5);

    // The failure is localized to the production predictor Task.
    const failedPredictor = taskByNode(failed, NODE_IDS.predictor);
    expect(failedPredictor).toMatchObject({
      state: 'failed',
      nodeId: NODE_IDS.predictor,
      manifestId: 'structure-prediction',
      manifestVersion: '2.0.0',
      failureKind: 'exit-code',
      exitCode: 125,
    });
    expect(failedPredictor.error).toContain('Slurm Job');
    expect(failedPredictor.error).toContain('FAILED');
    expect(failedPredictor.error).toContain('exit code 125');
    for (const nodeId of [NODE_IDS.target, NODE_IDS.generator, NODE_IDS.designer]) {
      expect(taskByNode(failed, nodeId).state).toBe('completed');
    }
    expect(taskByNode(failed, NODE_IDS.comparison).state).toBe('queued');

    // Model diagnostics are inspectable in the Task log.
    const failedLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${failed.run.id}/tasks/${failedPredictor.id}/logs`,
        production.cookie,
      ),
    );
    expect(failedLogs.available).toBe(true);
    expect(failedLogs.lines.join('\n')).toContain('model checkpoint');
    expect(failedLogs.lines.join('\n')).toContain(
      STRUCTURE_PREDICTION_PRODUCTION_IMAGE,
    );

    // Only upstream scientific records exist; the failed model produced no
    // partial Artifacts or Metrics and the downstream Node did not run.
    expect(failed.artifacts).toHaveLength(5);
    expect(failed.metrics).toHaveLength(5);
    expect(failed.artifacts.every((artifact) => artifact.nodeId !== NODE_IDS.predictor))
      .toBe(true);
    expect(failed.artifacts.every((artifact) => artifact.nodeId !== NODE_IDS.comparison))
      .toBe(true);
    expect(failed.metrics.every((metric) => metric.nodeId !== NODE_IDS.predictor))
      .toBe(true);

    // The earlier completed Run's scientific records were not rewritten.
    const successfulAfter = await readJson<RunDetailResponse>(
      await getJson(
        `${handle!.url}/api/runs/${successful.run.id}`,
        production.cookie,
      ),
    );
    expect(artifactDigests(successfulAfter)).toEqual(recordsBefore.artifacts);
    expect(metricContract(successfulAfter)).toEqual(recordsBefore.metrics);
    expect(successfulAfter.run.status).toBe('completed');

    // Result View inspection still works for the failed Run without rejection.
    const failedView = await resultView(production.cookie, failed.run.id);
    expect(failedView.compatibility.rejected).toEqual([]);

    // Clearing the model failure leaves the seam usable for a new Run.
    scheduler.executionFailureFor = undefined;
    const recovered = await runToTerminal(production.cookie);
    expect(recovered.run.status).toBe('completed');
    expect(recovered.artifacts).toHaveLength(12);
  });

  it('reports a production image packaging failure as a diagnosable Task failure without corrupting the Run', async () => {
    const production = await boot({
      executor: 'slurm',
      implementations: [productionStructurePredictionImplementation],
    });
    const scheduler = production.scheduler!;
    scheduler.submissionFailureFor = (manifestId, manifestVersion) =>
      `${manifestId}@${manifestVersion}` === PREDICTION_KEY
        ? `apptainer: image "${STRUCTURE_PREDICTION_PRODUCTION_IMAGE}" is not available in the local cache`
        : undefined;
    await saveWorkflow(
      production.cookie,
      productionWorkflow(production.fileReference),
    );

    const failed = await runToTerminal(production.cookie);
    expect(failed.run.status).toBe('failed');
    const predictor = taskByNode(failed, NODE_IDS.predictor);
    expect(predictor).toMatchObject({
      state: 'failed',
      nodeId: NODE_IDS.predictor,
      manifestId: 'structure-prediction',
      manifestVersion: '2.0.0',
      failureKind: 'unknown',
    });
    expect(predictor.error).toContain('sbatch failed');
    expect(predictor.error).toContain(STRUCTURE_PREDICTION_PRODUCTION_IMAGE);
    expect(predictor.error).toContain('apptainer');

    for (const nodeId of [NODE_IDS.target, NODE_IDS.generator, NODE_IDS.designer]) {
      expect(taskByNode(failed, nodeId).state).toBe('completed');
    }
    expect(failed.artifacts).toHaveLength(5);
    expect(failed.metrics).toHaveLength(5);
    expect(failed.artifacts.every((artifact) => artifact.nodeId !== NODE_IDS.predictor))
      .toBe(true);
  });

  it('accepts additional model replacements through the same registry, versioned Manifest, and environment seam', async () => {
    const nextVersionManifest = {
      ...productionStructurePredictionImplementation.manifest,
      version: NEXT_PREDICTION_VERSION,
      environment: {
        ...productionStructurePredictionImplementation.manifest.environment,
        image: `ghcr.io/sflow/nodes/structure-prediction-production:${NEXT_PREDICTION_VERSION}`,
      },
    };
    const nextVersionImplementation: NodeImplementation = {
      manifest: nextVersionManifest,
      run: productionStructurePredictionImplementation.run,
    };

    const production = await boot({
      executor: 'slurm',
      implementations: [
        productionStructurePredictionImplementation,
        nextVersionImplementation,
      ],
    });
    const workflow = productionWorkflow(production.fileReference, NEXT_PREDICTION_VERSION);
    await saveWorkflow(production.cookie, workflow);

    const catalog = await readJson<{ nodes: Array<{ id: string; version: string }> }>(
      await getJson(`${handle!.url}/api/nodes`, production.cookie),
    );
    expect(
      catalog.nodes
        .filter((node) => node.id === 'structure-prediction')
        .map((node) => node.version)
        .sort(),
    ).toEqual(['1.0.0', '2.0.0', '3.0.0']);
    expect(await validate(production.cookie)).toEqual({ valid: true, diagnostics: [] });

    const detail = await runToTerminal(production.cookie);
    expect(detail.run.status).toBe('completed');
    const predicate = taskByNode(detail, NODE_IDS.predictor);
    expect(predicate.manifestVersion).toBe(NEXT_PREDICTION_VERSION);
    for (const metric of detail.metrics.filter(
      (candidate) => candidate.nodeId === NODE_IDS.predictor,
    )) {
      expect(metric.provenance.executor.kind).toBe('slurm');
      expect(metric.schema.version).toBe(NEXT_PREDICTION_VERSION);
    }
    const snapshot = RunSnapshotSchema.parse(detail.run.snapshot);
    expect(
      snapshot.nodes.find((node) => node.nodeId === NODE_IDS.predictor)?.environment
        .image,
    ).toContain(NEXT_PREDICTION_VERSION);
  });
});
