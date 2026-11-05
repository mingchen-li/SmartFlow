import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CreateRunResponse,
  type FileReference,
  type RunDetailResponse,
  type RunEventsResponse,
  type RunListResponse,
  type TaskLogsResponse,
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
import { DRAFT_ID, NODE_IDS, TARGET_PDB, buildWorkflow, emptyLayout } from './workflow-fixture';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface ChildServer {
  url: string;
  stderr(): string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts the real `sflow start` CLI in its own process. Restarting a process is
 * what proves state is reconstructed from the Project directory, not memory.
 */
async function startChildServer(
  projectRoot: string,
  credential: string,
  executorDelayMs: number,
): Promise<ChildServer> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/cli/src/index.ts',
      'start',
      '--project',
      projectRoot,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--no-open',
      '--credential',
      credential,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, SFLOW_EXECUTOR_DELAY_MS: String(executorDelayMs) },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The Server process exited before listening:\n${stderr}`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`The Server process did not start:\n${stderr}`);
    }
    await sleep(100);
  }

  return {
    url,
    stderr: () => stderr,
    async stop(signal: NodeJS.Signals = 'SIGKILL') {
      // A child killed by a signal reports `exitCode: null` and sets
      // `signalCode`; without both checks cleanup would wait for an `exit`
      // event that already fired.
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (!child.kill(signal)) return;
      await exited;
    },
  };
}

describe('browser-close and Server-restart reconciliation', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;
  const children: ChildServer[] = [];

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    while (children.length > 0) await children.pop()!.stop();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function bootProject(options: { executorDelayMs?: number } = {}) {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-reconciliation-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);

    handle = await bootTestServer({ projectRoot, executorDelayMs: options.executorDelayMs });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;

    const registered = await postJson(
      `${handle.url}/api/files`,
      { path: 'targets/target.pdb' },
      cookie,
    );
    expect(registered.status).toBe(200);
    const fileReference = await readJson<FileReference>(registered);

    const saved = await putJson(
      `${handle.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow: buildWorkflow(fileReference), layout: emptyLayout },
      cookie,
    );
    expect(saved.status).toBe(200);

    return { cookie, fileReference, root: projectRoot };
  }

  async function startRun(cookie: string) {
    const response = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(response.status).toBe(201);
    return (await readJson<CreateRunResponse>(response)).run;
  }

  async function waitForTerminalAt(
    baseUrl: string,
    cookie: string,
    runId: string,
    timeoutMs = 15_000,
  ): Promise<RunDetailResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const detail = await readJson<RunDetailResponse>(
        await getJson(`${baseUrl}/api/runs/${runId}`, cookie),
      );
      if (['completed', 'failed', 'canceled'].includes(detail.run.status)) return detail;
      if (Date.now() > deadline) {
        throw new Error(`Run ${runId} did not reach a terminal state.`);
      }
      await sleep(20);
    }
  }

  it('keeps an active Run executing after the browser/API client disconnects', async () => {
    const { cookie } = await bootProject({ executorDelayMs: 120 });
    const run = await startRun(cookie);

    // The Run is active and server-owned before the browser goes away.
    const active = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${run.id}`, cookie),
    );
    expect(['queued', 'running']).toContain(active.run.status);
    expect(active.tasks).toHaveLength(5);
    expect(active.tasks.every((task) => task.attempt === 1)).toBe(true);

    // Browser close: abort the in-flight API request and make no further API
    // calls until the whole deterministic Run has had time to finish.
    const controller = new AbortController();
    const pending = fetch(`${handle!.url}/api/runs/${run.id}`, {
      headers: { cookie },
      signal: controller.signal,
    }).catch(() => undefined);
    controller.abort();
    await pending;
    await sleep(1_200);

    // Reopening the browser creates a fresh session; the Run and all of its
    // records are still there because the Server, not the browser, owns them.
    const reopened = await login(handle!.url, handle!.credential);
    const freshCookie = sessionCookie(reopened)!;
    expect(freshCookie).not.toBe(cookie);

    const listed = await readJson<RunListResponse>(
      await getJson(`${handle!.url}/api/runs`, freshCookie),
    );
    expect(listed.runs.map((entry) => entry.id)).toContain(run.id);

    const detail = await readJson<RunDetailResponse>(
      await getJson(`${handle!.url}/api/runs/${run.id}`, freshCookie),
    );
    expect(detail.run.status).toBe('completed');
    expect(detail.tasks).toHaveLength(5);
    for (const task of detail.tasks) {
      expect(task.state).toBe('completed');
      expect(task.attempt).toBe(1);
      expect(task.logsAvailable).toBe(true);
    }
    expect(detail.artifacts).toHaveLength(12);

    const logs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${run.id}/tasks/${detail.tasks[0].id}/logs`,
        freshCookie,
      ),
    );
    expect(logs.available).toBe(true);
    expect(logs.lines).toContain('state=completed');

    const events = await readJson<RunEventsResponse>(
      await getJson(`${handle!.url}/api/runs/${run.id}/events`, freshCookie),
    );
    expect(events.events.at(-1)?.type).toBe('run.completed');
  });

  it(
    'kills the real Server process mid-Run and reconciles from the Project directory on restart',
    { timeout: 60_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'sflow-restart-'));
      projectRoot = root;
      mkdirSync(join(root, 'targets'), { recursive: true });
      writeFileSync(join(root, 'targets', 'target.pdb'), TARGET_PDB);

      const credential = 'restart-credential';
      // The first process pauses before each Node so the Run is reliably
      // observable mid-flight; the restarted process runs without the delay.
      const first = await startChildServer(root, credential, 1_200);
      children.push(first);
      const cookie = sessionCookie(await login(first.url, credential))!;
      expect(cookie).toBeTruthy();

      const registered = await postJson(
        `${first.url}/api/files`,
        { path: 'targets/target.pdb' },
        cookie,
      );
      expect(registered.status).toBe(200);
      const fileReference = await readJson<FileReference>(registered);
      const saved = await putJson(
        `${first.url}/api/workflows/${DRAFT_ID}`,
        { name: 'Binder design', workflow: buildWorkflow(fileReference), layout: emptyLayout },
        cookie,
      );
      expect(saved.status).toBe(200);

      const started = await postJson(
        `${first.url}/api/workflows/${DRAFT_ID}/runs`,
        {},
        cookie,
      );
      expect(started.status).toBe(201);
      const run = (await readJson<CreateRunResponse>(started)).run;

      // Captured before the crash: one Task is complete, another is running.
      let midRun: RunDetailResponse | undefined;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const detail = await readJson<RunDetailResponse>(
          await getJson(`${first.url}/api/runs/${run.id}`, cookie),
        );
        if (
          detail.tasks.some((task) => task.state === 'completed') &&
          detail.tasks.some((task) => task.state === 'running')
        ) {
          midRun = detail;
          break;
        }
        if (['completed', 'failed', 'canceled'].includes(detail.run.status)) {
          throw new Error('The Run finished before the Server could be killed.');
        }
        if (Date.now() > deadline) {
          throw new Error(
            `The Run never became active: ${detail.tasks
              .map((task) => `${task.nodeId}=${task.state}`)
              .join(', ')}`,
          );
        }
        await sleep(10);
      }
      if (!midRun) throw new Error('No mid-Run state was captured.');

      const completedBefore = midRun.tasks.filter((task) => task.state === 'completed');
      const runningBefore = midRun.tasks.find((task) => task.state === 'running')!;
      const logsBefore = new Map<string, string[]>();
      for (const task of completedBefore) {
        const logs = await readJson<TaskLogsResponse>(
          await getJson(
            `${first.url}/api/runs/${run.id}/tasks/${task.id}/logs`,
            cookie,
          ),
        );
        expect(logs.available).toBe(true);
        logsBefore.set(task.id, logs.lines);
      }
      const artifactsBefore = midRun.artifacts;

      // SIGKILL: no graceful shutdown, no cancellation, no terminal writes.
      await first.stop('SIGKILL');

      // A brand-new process serves the same Project directory on a new port.
      const second = await startChildServer(root, credential, 0);
      children.push(second);
      const reopened = await login(second.url, credential);
      const freshCookie = sessionCookie(reopened)!;
      expect(freshCookie).toBeTruthy();
      expect(freshCookie).not.toBe(cookie);

      // The Run is visible immediately after restart, rebuilt from disk.
      const listed = await readJson<RunListResponse>(
        await getJson(`${second.url}/api/runs`, freshCookie),
      );
      expect(listed.runs.map((entry) => entry.id)).toContain(run.id);

      const after = await waitForTerminalAt(second.url, freshCookie, run.id, 30_000);
      expect(after.run.status).toBe('completed');

      // Every Node ended with exactly one completed Task; nothing was re-run
      // that had already completed, and the interrupted Node resumed as a new
      // attempt rather than overwriting its failed history.
      const nodeIds = Object.values(NODE_IDS);
      expect(nodeIds).toHaveLength(5);
      for (const nodeId of nodeIds) {
        const completed = after.tasks.filter(
          (task) => task.nodeId === nodeId && task.state === 'completed',
        );
        expect(completed).toHaveLength(1);
      }
      expect(after.tasks).toHaveLength(6);

      const interrupted = after.tasks.find((task) => task.id === runningBefore.id)!;
      expect(interrupted).toMatchObject({
        nodeId: runningBefore.nodeId,
        attempt: 1,
        state: 'failed',
        exitCode: 137,
        error: 'The Server restarted while this Task attempt was running.',
      });
      const resumed = after.tasks.find(
        (task) => task.nodeId === runningBefore.nodeId && task.id !== runningBefore.id,
      )!;
      expect(resumed).toMatchObject({ attempt: 2, state: 'completed', exitCode: 0 });

      // Completed Tasks keep their identity, logs, and immutable Artifacts.
      for (const task of completedBefore) {
        const same = after.tasks.find((candidate) => candidate.id === task.id)!;
        expect(same).toMatchObject({
          state: 'completed',
          attempt: 1,
          jobId: task.jobId,
        });
        expect(same.completedAt).toBe(task.completedAt);
        const logs = await readJson<TaskLogsResponse>(
          await getJson(
            `${second.url}/api/runs/${run.id}/tasks/${task.id}/logs`,
            freshCookie,
          ),
        );
        expect(logs.available).toBe(true);
        expect(logs.lines).toEqual(logsBefore.get(task.id));
      }
      for (const artifact of artifactsBefore) {
        expect(after.artifacts.find((candidate) => candidate.id === artifact.id)).toEqual(
          artifact,
        );
      }

      // The interrupted attempt's own log survives as history.
      const interruptedLogs = await readJson<TaskLogsResponse>(
        await getJson(
          `${second.url}/api/runs/${run.id}/tasks/${interrupted.id}/logs`,
          freshCookie,
        ),
      );
      expect(interruptedLogs.available).toBe(true);
      expect(interruptedLogs.lines).toContain('state=running');
      expect(interruptedLogs.lines).not.toContain('state=completed');

      // Outputs and records reconstructed after restart are complete and valid.
      expect(after.artifacts).toHaveLength(12);
      expect(after.metrics.length).toBeGreaterThan(0);
      for (const artifact of after.artifacts) {
        const bytes = readFileSync(join(root, artifact.path));
        expect(artifact.size).toBe(bytes.byteLength);
        expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }

      const resumedLogs = await readJson<TaskLogsResponse>(
        await getJson(
          `${second.url}/api/runs/${run.id}/tasks/${resumed.id}/logs`,
          freshCookie,
        ),
      );
      expect(resumedLogs.lines).toContain('state=completed');

      // One start, one interruption, five completions: the history is coherent.
      const { events } = await readJson<RunEventsResponse>(
        await getJson(`${second.url}/api/runs/${run.id}/events`, freshCookie),
      );
      expect(events[0].type).toBe('run.created');
      expect(events.at(-1)?.type).toBe('run.completed');
      expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'task.completed')).toHaveLength(5);
      expect(
        events.filter((event) => event.type === 'task.failed').map((event) => event.taskId),
      ).toEqual([interrupted.id]);

      const project = await readJson<{ state: string }>(
        await getJson(`${second.url}/api/project`, freshCookie),
      );
      expect(project.state).toBe('idle');
    },
  );
});
