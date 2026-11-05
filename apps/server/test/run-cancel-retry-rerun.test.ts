import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NodeExecutionError,
  type CreateRunResponse,
  type ErrorResponse,
  type FileReference,
  type NodeFailureKind,
  type NodeImplementation,
  type RunDetailResponse,
  type RunEventsResponse,
  type TaskLogsResponse,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinNodeImplementation } from '@sflow/nodes';
import {
  bootTestServer,
  getJson,
  login,
  postJson,
  putJson,
  readJson,
  sessionCookie,
  type BootTestServerOptions,
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
  const deadline = Date.now() + 20_000;
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

/**
 * Test-only deterministic failure injection: the selected Node throws a
 * classified failure for the attempts chosen by `failureFor`, then delegates
 * to the real built-in implementation.
 */
function failingImplementation(
  manifestId: string,
  failureFor: (attempt: number) => NodeFailureKind | undefined,
): NodeImplementation {
  const base = builtinNodeImplementation(manifestId);
  if (!base) throw new Error(`Missing built-in implementation ${manifestId}`);
  return {
    manifest: base.manifest,
    run(input, parameters, context) {
      const failureKind = failureFor(context.attempt);
      if (failureKind) {
        throw new NodeExecutionError(
          failureKind,
          `synthetic ${failureKind} failure on attempt ${context.attempt}`,
        );
      }
      return base.run(input, parameters, context);
    },
  };
}

const immediateRetry = async (): Promise<boolean> => true;

describe('Run cancellation, retry, and explicit rerun API', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(
    options: Omit<BootTestServerOptions, 'projectRoot'> = {},
  ): Promise<{ cookie: string; fileReference: FileReference; root: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-cancel-retry-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);

    handle = await bootTestServer({ projectRoot, ...options });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;
    const registered = await postJson(
      `${handle!.url}/api/files`,
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

  async function startRun(cookie: string): Promise<CreateRunResponse['run']> {
    const response = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(response.status).toBe(201);
    return (await readJson<CreateRunResponse>(response)).run;
  }

  async function eventsFor(cookie: string, runId: string): Promise<RunEventsResponse['events']> {
    const response = await getJson(`${handle!.url}/api/runs/${runId}/events`, cookie);
    expect(response.status).toBe(200);
    return (await readJson<RunEventsResponse>(response)).events;
  }

  it('cancels queued and running work while leaving completed Tasks and Artifacts unchanged', async () => {
    const { cookie, fileReference } = await boot({ executorDelayMs: 300 });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const inFlight = await waitFor(
      handle!,
      cookie,
      run.id,
      (detail) =>
        detail.tasks.find((task) => task.nodeId === NODE_IDS.target)?.state === 'completed' &&
        detail.tasks.find((task) => task.nodeId === NODE_IDS.generator)?.state === 'running',
    );
    const completedBefore = inFlight.tasks.find((task) => task.nodeId === NODE_IDS.target)!;
    const artifactsBefore = JSON.stringify(inFlight.artifacts);
    expect(inFlight.artifacts.length).toBeGreaterThan(0);

    const canceled = await postJson(
      `${handle!.url}/api/runs/${run.id}/cancel`,
      {},
      cookie,
    );
    expect(canceled.status).toBe(200);
    expect((await readJson<{ run: { status: string } }>(canceled)).run.status).toBe('canceled');

    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('canceled');

    // Completed science and its Artifacts are never rewritten by cancellation.
    const target = detail.tasks.find((task) => task.id === completedBefore.id)!;
    expect(target).toMatchObject({
      state: 'completed',
      exitCode: 0,
      completedAt: completedBefore.completedAt,
    });
    expect(JSON.stringify(detail.artifacts)).toBe(artifactsBefore);

    // The running attempt stopped through the executor; downstream work never ran.
    const generator = detail.tasks.find((task) => task.nodeId === NODE_IDS.generator)!;
    expect(generator).toMatchObject({ state: 'canceled', exitCode: 130 });
    for (const nodeId of [NODE_IDS.designer, NODE_IDS.predictor, NODE_IDS.comparison]) {
      expect(detail.tasks.find((task) => task.nodeId === nodeId)).toMatchObject({
        state: 'canceled',
      });
    }

    const events = await eventsFor(cookie, run.id);
    expect(events.filter((event) => event.type === 'task.canceled')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'run.canceled')).toHaveLength(1);

    // Canceling again is idempotent: same terminal Run, no new history.
    const again = await postJson(`${handle!.url}/api/runs/${run.id}/cancel`, {}, cookie);
    expect(again.status).toBe(200);
    expect((await readJson<{ run: { status: string } }>(again)).run.status).toBe('canceled');
    expect(await eventsFor(cookie, run.id)).toHaveLength(events.length);
    expect((await getJson(`${handle!.url}/api/runs/${run.id}`, cookie)).status).toBe(200);
    const after = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${run.id}`, cookie),
    );
    expect(after.tasks).toEqual(detail.tasks);
  });

  it('retries a transient failure as a separate attempt with its own logs and then completes', async () => {
    const { cookie, fileReference } = await boot({
      nodeImplementations: [
        failingImplementation('sequence-design', (attempt) =>
          attempt === 1 ? 'transient' : undefined,
        ),
      ],
      retryWait: immediateRetry,
    });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('completed');

    const attempts = detail.tasks
      .filter((task) => task.nodeId === NODE_IDS.designer)
      .sort((left, right) => left.attempt - right.attempt);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      state: 'failed',
      failureKind: 'transient',
      exitCode: 1,
    });
    expect(attempts[0].error).toContain('synthetic transient failure on attempt 1');
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      state: 'completed',
      exitCode: 0,
    });

    const failedLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${run.id}/tasks/${attempts[0].id}/logs`,
        cookie,
      ),
    );
    expect(failedLogs.available).toBe(true);
    expect(failedLogs.lines).toEqual(
      expect.arrayContaining([
        'state=running',
        'error=synthetic transient failure on attempt 1',
        'state=failed',
      ]),
    );
    const retryLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${run.id}/tasks/${attempts[1].id}/logs`,
        cookie,
      ),
    );
    expect(retryLogs.lines).toEqual(
      expect.arrayContaining(['node=sequence-design attempt=2', 'state=completed']),
    );

    const events = await eventsFor(cookie, run.id);
    expect(
      events.filter((event) => event.type === 'task.retry.scheduled'),
    ).toHaveLength(1);
    expect(events.find((event) => event.type === 'task.retry.scheduled')).toMatchObject({
      taskId: attempts[1].id,
      payload: {
        nodeId: NODE_IDS.designer,
        attempt: 2,
        previousAttempt: 1,
        failureKind: 'transient',
      },
    });
    expect(events.some((event) => event.type === 'run.failed')).toBe(false);
    // The retried Node's downstream work still ran once and completed.
    expect(
      detail.tasks.filter((task) => task.nodeId === NODE_IDS.predictor && task.state === 'completed'),
    ).toHaveLength(1);
  });

  it('stops retrying at maxAttempts and ends the Run failed', async () => {
    const { cookie, fileReference } = await boot({
      nodeImplementations: [
        failingImplementation('sequence-design', () => 'transient'),
      ],
      retryWait: immediateRetry,
    });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('failed');

    const attempts = detail.tasks
      .filter((task) => task.nodeId === NODE_IDS.designer)
      .sort((left, right) => left.attempt - right.attempt);
    expect(attempts.map((task) => [task.attempt, task.state, task.failureKind])).toEqual([
      [1, 'failed', 'transient'],
      [2, 'failed', 'transient'],
    ]);
    expect(detail.tasks.filter((task) => task.nodeId === NODE_IDS.designer)).toHaveLength(2);

    const events = await eventsFor(cookie, run.id);
    expect(events.filter((event) => event.type === 'task.failed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'task.retry.scheduled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(1);
  });

  it('never retries a parameter error, even though the Manifest retries transient failures', async () => {
    const { cookie, fileReference } = await boot({
      nodeImplementations: [
        failingImplementation('sequence-design', (attempt) =>
          attempt === 1 ? 'parameter' : undefined,
        ),
      ],
      retryWait: immediateRetry,
    });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const detail = await waitForTerminal(handle!, cookie, run.id);
    expect(detail.run.status).toBe('failed');
    const attempts = detail.tasks.filter((task) => task.nodeId === NODE_IDS.designer);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      state: 'failed',
      failureKind: 'parameter',
      exitCode: 1,
    });

    const events = await eventsFor(cookie, run.id);
    expect(events.some((event) => event.type === 'task.retry.scheduled')).toBe(false);
    expect(events.at(-1)?.type).toBe('run.failed');
  });

  it('reruns a failed Task as a new attempt, retains failure history, and completes the Run', async () => {
    const { cookie, fileReference } = await boot({
      nodeImplementations: [
        failingImplementation('sequence-design', (attempt) =>
          attempt === 1 ? 'parameter' : undefined,
        ),
      ],
      retryWait: immediateRetry,
    });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const failedDetail = await waitForTerminal(handle!, cookie, run.id);
    expect(failedDetail.run.status).toBe('failed');
    const failedTask = failedDetail.tasks.find(
      (task) => task.nodeId === NODE_IDS.designer && task.attempt === 1,
    )!;
    expect(failedTask).toMatchObject({
      state: 'failed',
      failureKind: 'parameter',
      exitCode: 1,
    });
    const completedBefore = failedDetail.tasks
      .filter((task) => task.state === 'completed')
      .map((task) => ({ id: task.id, nodeId: task.nodeId }));
    expect(completedBefore).toHaveLength(2);

    const rerun = await postJson(
      `${handle!.url}/api/runs/${run.id}/tasks/${failedTask.id}/rerun`,
      {},
      cookie,
    );
    expect(rerun.status).toBe(200);
    const rerunBody = await readJson<{
      run: { status: string };
      task: { id: string; nodeId: string; attempt: number; state: string };
    }>(rerun);
    expect(rerunBody.run.status).toBe('running');
    expect(rerunBody.task).toMatchObject({
      nodeId: NODE_IDS.designer,
      attempt: 2,
      state: 'queued',
    });

    const completed = await waitForTerminal(handle!, cookie, run.id);
    expect(completed.run.status).toBe('completed');

    // The original failure record and its logs remain inspectable and unchanged.
    const original = completed.tasks.find((task) => task.id === failedTask.id)!;
    expect(original).toMatchObject({
      attempt: 1,
      state: 'failed',
      failureKind: 'parameter',
      exitCode: 1,
      error: failedTask.error,
      completedAt: failedTask.completedAt,
      logsPath: failedTask.logsPath,
    });
    const originalLogs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${run.id}/tasks/${failedTask.id}/logs`,
        cookie,
      ),
    );
    expect(originalLogs.available).toBe(true);
    expect(originalLogs.lines).toEqual(
      expect.arrayContaining(['error=synthetic parameter failure on attempt 1', 'state=failed']),
    );

    // The rerun created a new attempt; completed upstream work was reused.
    const designerAttempts = completed.tasks
      .filter((task) => task.nodeId === NODE_IDS.designer)
      .sort((left, right) => left.attempt - right.attempt);
    expect(designerAttempts.map((task) => [task.attempt, task.state])).toEqual([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    for (const task of completedBefore) {
      expect(completed.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
        state: 'completed',
      });
    }
    expect(
      completed.tasks.filter((task) => task.nodeId === NODE_IDS.target),
    ).toHaveLength(1);

    const events = await eventsFor(cookie, run.id);
    expect(events.filter((event) => event.type === 'run.rerun')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.completed');

    // Completed Tasks and superseded attempts are rejected with 409.
    const completedTask = completed.tasks.find(
      (task) => task.nodeId === NODE_IDS.target,
    )!;
    const rejectCompleted = await postJson(
      `${handle!.url}/api/runs/${run.id}/tasks/${completedTask.id}/rerun`,
      {},
      cookie,
    );
    expect(rejectCompleted.status).toBe(409);
    expect((await readJson<ErrorResponse>(rejectCompleted)).error.code).toBe('TASK_COMPLETED');

    const rejectSuperseded = await postJson(
      `${handle!.url}/api/runs/${run.id}/tasks/${failedTask.id}/rerun`,
      {},
      cookie,
    );
    expect(rejectSuperseded.status).toBe(409);
    expect((await readJson<ErrorResponse>(rejectSuperseded)).error.code).toBe(
      'TASK_SUPERSEDED',
    );
  });

  it('reruns canceled work after cancellation and drives the Run to completion', async () => {
    const { cookie, fileReference } = await boot({ executorDelayMs: 200 });
    await saveWorkflow(cookie, buildWorkflow(fileReference));
    const run = await startRun(cookie);

    const inFlight = await waitFor(
      handle!,
      cookie,
      run.id,
      (detail) =>
        detail.tasks.find((task) => task.nodeId === NODE_IDS.target)?.state === 'completed' &&
        detail.tasks.find((task) => task.nodeId === NODE_IDS.generator)?.state === 'running',
    );
    await postJson(`${handle!.url}/api/runs/${run.id}/cancel`, {}, cookie);
    const canceled = await waitForTerminal(handle!, cookie, run.id);
    expect(canceled.run.status).toBe('canceled');

    const canceledDesigner = canceled.tasks.find(
      (task) => task.nodeId === NODE_IDS.designer && task.attempt === 1,
    )!;
    expect(canceledDesigner.state).toBe('canceled');
    const canceledGenerator = canceled.tasks.find(
      (task) => task.nodeId === NODE_IDS.generator && task.attempt === 1,
    )!;
    expect(canceledGenerator.state).toBe('canceled');

    const rerun = await postJson(
      `${handle!.url}/api/runs/${run.id}/tasks/${canceledDesigner.id}/rerun`,
      {},
      cookie,
    );
    expect(rerun.status).toBe(200);

    const completed = await waitForTerminal(handle!, cookie, run.id);
    expect(completed.run.status).toBe('completed');
    expect(completed.tasks.find((task) => task.id === canceledDesigner.id)).toMatchObject({
      state: 'canceled',
    });
    expect(completed.tasks.find((task) => task.id === canceledGenerator.id)).toMatchObject({
      state: 'canceled',
    });

    for (const nodeId of [
      NODE_IDS.generator,
      NODE_IDS.designer,
      NODE_IDS.predictor,
      NODE_IDS.comparison,
    ]) {
      const latest = completed.tasks
        .filter((task) => task.nodeId === nodeId)
        .sort((left, right) => left.attempt - right.attempt)
        .at(-1)!;
      expect(latest).toMatchObject({ attempt: 2, state: 'completed' });
    }
    // The Target completed before cancellation and was not rerun.
    expect(
      completed.tasks.filter((task) => task.nodeId === NODE_IDS.target),
    ).toHaveLength(1);

    // Rerunning the canceled attempt again is rejected because it is superseded.
    const reject = await postJson(
      `${handle!.url}/api/runs/${run.id}/tasks/${canceledDesigner.id}/rerun`,
      {},
      cookie,
    );
    expect(reject.status).toBe(409);
    expect((await readJson<ErrorResponse>(reject)).error.code).toBe('TASK_SUPERSEDED');
  });

  it('guards cancellation and rerun behind authentication', async () => {
    await boot();
    const cancel = await fetch(`${handle!.url}/api/runs/run-1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancel.status).toBe(401);
    const rerun = await fetch(`${handle!.url}/api/runs/run-1/tasks/task-1/rerun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rerun.status).toBe(401);
  });
});
