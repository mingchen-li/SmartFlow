import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreateRunResponse,
  FileReference,
  Run,
  RunDetailResponse,
  RunEventsResponse,
  RunListResponse,
  TaskLogsResponse,
  WorkflowIR,
} from '@sflow/domain';
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

async function waitFor(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
  predicate: (detail: RunDetailResponse) => boolean,
): Promise<RunDetailResponse> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const detail = await readJson<RunDetailResponse>(
      await getJson(`${handle.url}/api/runs/${runId}`, cookie),
    );
    if (predicate(detail)) return detail;
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} did not reach the expected state.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForTerminal(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
): Promise<RunDetailResponse> {
  return waitFor(handle, cookie, runId, ({ run }) =>
    ['completed', 'failed', 'canceled'].includes(run.status),
  );
}

describe('Run execution API', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(): Promise<{ cookie: string; fileReference: FileReference; root: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-execution-'));
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

  async function saveWorkflow(
    cookie: string,
    workflow: WorkflowIR,
  ): Promise<void> {
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

  it('executes a Run end to end through the real HTTP app and exposes Tasks, logs, events, Artifacts, and Metrics', async () => {
    const { cookie, fileReference, root } = await boot();
    await saveWorkflow(cookie, buildWorkflow(fileReference));

    const created = await startRun(cookie);
    expect(created.status).toBe('queued');

    // The response already returned; execution is observable in the background.
    const inFlight = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${created.id}`, cookie),
    );
    expect(inFlight.run.id).toBe(created.id);
    expect(inFlight.tasks).toHaveLength(5);
    expect(inFlight.tasks.every((task) => task.attempt === 1)).toBe(true);

    const detail = await waitForTerminal(handle!, cookie, created.id);
    expect(detail.run.status).toBe('completed');
    expect(detail.run.workflowId).toBe(DRAFT_ID);
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
      expect(task.logsPath).toBe(
        `.sflow/runs/${created.id}/tasks/${task.id}/logs.txt`,
      );

      const logsResponse = await getJson(
        `${handle!.url}/api/runs/${created.id}/tasks/${task.id}/logs`,
        cookie,
      );
      expect(logsResponse.status).toBe(200);
      const logs = await readJson<TaskLogsResponse>(logsResponse);
      expect(logs).toMatchObject({
        runId: created.id,
        taskId: task.id,
        available: true,
        logsPath: task.logsPath,
      });
      expect(logs.lines).toContain(`node=${task.manifestId} attempt=1`);
      expect(logs.lines).toContain('state=running');
      expect(logs.lines).toContain('state=completed');
    }

    const targetTask = detail.tasks.find((task) => task.nodeId === NODE_IDS.target)!;
    const targetLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${created.id}/tasks/${targetTask.id}/logs`,
        cookie,
      ),
    );
    expect(targetLogs.lines).toContain('loaded target.path=targets/target.pdb');

    // Managed outputs are real files and immutable content-addressed records.
    expect(detail.artifacts).toHaveLength(12);
    for (const artifact of detail.artifacts) {
      expect(artifact.runId).toBe(created.id);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.mediaType).toBeTruthy();
      expect(artifact.path.startsWith(`.sflow/runs/${created.id}/tasks/`)).toBe(true);
      const bytes = readFileSync(join(root, artifact.path));
      expect(artifact.size).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(artifact.provenance).toMatchObject({
        runId: created.id,
        taskId: artifact.taskId,
        nodeId: artifact.nodeId,
        attempt: 1,
        manifestVersion: '1.0.0',
        executor: { kind: 'local', jobId: expect.any(String) },
      });
    }
    const candidatesArtifact = detail.artifacts.find(
      (artifact) => artifact.name === 'candidates.json',
    )!;
    expect(candidatesArtifact.schema).toEqual({
      namespace: 'sflow.binder',
      name: 'candidate-set',
      version: '1.0.0',
    });
    const candidates = JSON.parse(readFileSync(join(root, candidatesArtifact.path), 'utf8')) as {
      candidates: unknown[];
    };
    expect(candidates.candidates).toHaveLength(5);

    // Immutability is enforced by the persistence seam.
    const artifactRecord = {
      runId: candidatesArtifact.runId,
      taskId: candidatesArtifact.taskId,
      nodeId: candidatesArtifact.nodeId,
      name: candidatesArtifact.name,
      mediaType: candidatesArtifact.mediaType,
      path: candidatesArtifact.path,
      sha256: candidatesArtifact.sha256,
      size: candidatesArtifact.size,
      ...(candidatesArtifact.schema ? { schema: candidatesArtifact.schema } : {}),
      provenance: candidatesArtifact.provenance,
      createdAt: candidatesArtifact.createdAt,
    };
    expect(() =>
      handle!.server.store.recordArtifact({
        ...artifactRecord,
        sha256: '0'.repeat(64),
      }),
    ).toThrow(/immutable/);
    expect(handle!.server.store.recordArtifact(artifactRecord).id).toBe(candidatesArtifact.id);

    // Metrics are typed, described, namespaced, and carry Provenance.
    const meanPlddt = detail.metrics.find((metric) => metric.metricId === 'meanPlddt')!;
    expect(meanPlddt).toMatchObject({
      runId: created.id,
      nodeId: NODE_IDS.predictor,
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 100 },
      direction: 'higher-is-better',
      schema: {
        namespace: 'sflow.binder.structure-prediction',
        name: 'meanPlddt',
        version: '1.0.0',
      },
      provenance: {
        manifestId: 'structure-prediction',
        manifestVersion: '1.0.0',
        parameters: { predictor: 'esmfold2', seed: 1 },
        environment: {
          kind: 'container',
          image: 'ghcr.io/sflow/nodes/structure-prediction:1.0.0',
        },
        executor: { kind: 'local' },
      },
    });
    expect(meanPlddt.value).toBeGreaterThanOrEqual(0);
    expect(meanPlddt.value).toBeLessThanOrEqual(100);
    expect(meanPlddt.provenance.inputs.artifacts.length).toBeGreaterThan(0);
    expect(detail.metrics.map((metric) => metric.metricId)).toEqual(
      expect.arrayContaining([
        'targetResidueCount',
        'candidateCount',
        'uniqueCandidates',
        'designCount',
        'meanConfidence',
        'scoredCount',
        'meanPlddt',
        'meanIptm',
        'selectedCount',
        'bestPlddt',
      ]),
    );

    // Events are append-only and ordered.
    const eventsResponse = await getJson(
      `${handle!.url}/api/runs/${created.id}/events`,
      cookie,
    );
    expect(eventsResponse.status).toBe(200);
    const { events } = await readJson<RunEventsResponse>(eventsResponse);
    expect(events[0].type).toBe('run.created');
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'task.queued',
        'task.running',
        'task.completed',
        'artifact.recorded',
        'metric.recorded',
      ]),
    );
    expect(events.filter((event) => event.type === 'task.queued')).toHaveLength(5);
    expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(5);
    const ids = events.map((event) => event.id);
    expect([...ids].sort((left, right) => left - right)).toEqual(ids);

    const after = events[Math.floor(events.length / 2)].id;
    const laterResponse = await getJson(
      `${handle!.url}/api/runs/${created.id}/events?after=${after}`,
      cookie,
    );
    const later = await readJson<RunEventsResponse>(laterResponse);
    expect(later.events.every((event) => event.id > after)).toBe(true);
    expect(later.events.length).toBe(events.length - events.findIndex((event) => event.id > after));

    // The Run list stays a lightweight Run summary.
    const listed = await readJson<RunListResponse>(
      await getJson(`${handle!.url}/api/runs`, cookie),
    );
    expect(listed.runs).toEqual([detail.run]);
  });

  it('produces deterministic Artifacts for repeated Runs of the same snapshot', async () => {
    const { cookie, fileReference } = await boot();
    await saveWorkflow(cookie, buildWorkflow(fileReference));

    const first = await startRun(cookie);
    const firstDetail = await waitForTerminal(handle!, cookie, first.id);
    const second = await startRun(cookie);
    const secondDetail = await waitForTerminal(handle!, cookie, second.id);

    expect(firstDetail.run.status).toBe('completed');
    expect(secondDetail.run.status).toBe('completed');

    const digests = (detail: RunDetailResponse): Record<string, string[]> => {
      const byName: Record<string, string[]> = {};
      for (const artifact of detail.artifacts) {
        const key = `${artifact.nodeId}/${artifact.name}`;
        (byName[key] ??= []).push(artifact.sha256);
      }
      for (const key of Object.keys(byName)) byName[key].sort();
      return byName;
    };
    expect(digests(firstDetail)).toEqual(digests(secondDetail));
    expect(Object.keys(digests(firstDetail)).length).toBe(12);

    expect(firstDetail.tasks.map((task) => task.id)).not.toEqual(
      secondDetail.tasks.map((task) => task.id),
    );
  });

  it('persists a failed Task and Run with its error and log lines', async () => {
    const { cookie, fileReference } = await boot();
    const workflow = buildWorkflow(fileReference);
    const target = workflow.nodes.find((node) => node.id === NODE_IDS.target)!;
    target.parameters = {
      ...target.parameters,
      targetFile: {
        fileReferenceId: 'missing-file',
        path: 'targets/missing.pdb',
        name: 'missing.pdb',
      },
    };
    await saveWorkflow(cookie, workflow);

    const created = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, created.id);

    expect(detail.run.status).toBe('failed');
    const targetTask = detail.tasks.find((task) => task.nodeId === NODE_IDS.target)!;
    expect(targetTask.state).toBe('failed');
    expect(targetTask.exitCode).toBe(1);
    expect(targetTask.error).toContain('targets/missing.pdb');
    expect(targetTask.logsAvailable).toBe(true);
    expect(
      detail.tasks
        .filter((task) => task.nodeId !== NODE_IDS.target)
        .map((task) => task.state),
    ).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(detail.artifacts).toEqual([]);
    expect(detail.metrics).toEqual([]);

    const logs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${created.id}/tasks/${targetTask.id}/logs`,
        cookie,
      ),
    );
    expect(logs.lines).toEqual(
      expect.arrayContaining([
        'state=running',
        'error=Target file "targets/missing.pdb" could not be read from the Project.',
        'state=failed',
      ]),
    );

    const { events } = await readJson<RunEventsResponse>(
      await getJson(`${handle!.url}/api/runs/${created.id}/events`, cookie),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task.failed', 'run.failed']),
    );
  });

  it('guards Run execution routes and returns 404 for unknown Runs and Tasks', async () => {
    const { cookie, fileReference } = await boot();
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const created = await startRun(cookie);
    const detail = await waitForTerminal(handle!, cookie, created.id);
    const task = detail.tasks[0];

    expect((await getJson(`${handle!.url}/api/runs/${created.id}`)).status).toBe(401);
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/${created.id}/tasks/${task.id}/logs`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await getJson(`${handle!.url}/api/runs/${created.id}/events`)).status,
    ).toBe(401);

    expect(
      (await getJson(`${handle!.url}/api/runs/missing`, cookie)).status,
    ).toBe(404);
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/${created.id}/tasks/missing/logs`,
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await getJson(
          `${handle!.url}/api/runs/missing/tasks/${task.id}/logs`,
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (await getJson(`${handle!.url}/api/runs/missing/events`, cookie)).status,
    ).toBe(404);
  });
});
