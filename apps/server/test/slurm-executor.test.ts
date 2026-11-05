import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreateRunResponse,
  FileReference,
  RunDetailResponse,
  TaskLogsResponse,
} from '@sflow/domain';
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from '@sflow/orchestrator';
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
  TARGET_PDB,
  buildWorkflow,
  emptyLayout,
} from './workflow-fixture';

interface FakeSchedulerJob {
  id: string;
  taskDir: string;
  outputTemplate: string;
  polls: number;
}

/**
 * Minimal Slurm scheduler stand-in for Server wiring tests. Every Job reaches
 * RUNNING and then COMPLETED, writes a log, and returns a valid Node result.
 */
class AutoCompleteScheduler implements CommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly jobs = new Map<string, FakeSchedulerJob>();
  private nextId = 5001;

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    const args = invocation.args;

    if (invocation.command === 'sbatch') {
      const id = String(this.nextId++);
      this.jobs.set(id, {
        id,
        taskDir: argument(args, '--chdir') ?? '',
        outputTemplate: argument(args, '--output') ?? '',
        polls: 0,
      });
      return ok(`${id};test-cluster\n`);
    }

    const jobId = jobIdFrom(args);
    const job = jobId ? this.jobs.get(jobId) : undefined;

    if (invocation.command === 'squeue' && job) {
      job.polls += 1;
      if (job.polls < 2) return ok('RUNNING\n');
      this.complete(job);
      return ok('');
    }
    if (invocation.command === 'sacct' && job) {
      return ok(`${job.id}|COMPLETED|0:0\n`);
    }
    if (invocation.command === 'scancel') {
      return ok('');
    }
    return ok('');
  }

  private complete(job: FakeSchedulerJob): void {
    mkdirSync(job.taskDir, { recursive: true });
    writeFileSync(
      job.outputTemplate.replace('%j', job.id).replace('%A', job.id),
      `slurm_job=${job.id}\nnode completed\n`,
    );
    writeFileSync(
      join(job.taskDir, 'result.json'),
      JSON.stringify({
        outputs: [],
        metrics: [
          {
            spec: {
              id: 'confidence',
              name: 'Confidence',
              description: 'A deterministic scheduler acceptance score.',
              valueType: 'number',
            },
            value: 0.5,
            schema: { namespace: 'sflow.test', name: 'confidence', version: '1.0.0' },
          },
        ],
      }),
    );
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function argument(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function jobIdFrom(args: string[]): string | undefined {
  for (const value of args) {
    const match = /^--job(?:s)?=(.+)$/.exec(value);
    if (match) return match[1];
  }
  return undefined;
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
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not finish.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Server Compute Executor selection', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    delete process.env.SFLOW_EXECUTOR;
    await handle?.close();
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  it('keeps LocalExecutor as the default and selects Slurm by option or environment', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-executor-select-'));

    handle = await bootTestServer({ projectRoot });
    expect(handle.server.executorKind).toBe('local');
    await handle.close({ cleanupProject: false });
    handle = undefined;

    const scheduler = new AutoCompleteScheduler();
    handle = await bootTestServer({ projectRoot, executor: 'slurm', commandRunner: scheduler });
    expect(handle.server.executorKind).toBe('slurm');
    await handle.close({ cleanupProject: false });
    handle = undefined;

    process.env.SFLOW_EXECUTOR = 'slurm';
    handle = await bootTestServer({ projectRoot, commandRunner: new AutoCompleteScheduler() });
    expect(handle.server.executorKind).toBe('slurm');
    await handle.close({ cleanupProject: false });
    handle = undefined;
  });

  it('runs an entire Workflow through Slurm Jobs and records Slurm Provenance', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-slurm-run-'));
    mkdirSync(join(projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(projectRoot, 'targets', 'target.pdb'), TARGET_PDB);
    const scheduler = new AutoCompleteScheduler();
    handle = await bootTestServer({
      projectRoot,
      executor: 'slurm',
      commandRunner: scheduler,
    });

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
    const created = await readJson<CreateRunResponse>(
      await postJson(`${handle.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );

    const detail = await waitForTerminal(handle, cookie, created.run.id);

    expect(detail.run.status).toBe('completed');
    expect(detail.executorKind).toBe('slurm');
    expect(detail.tasks).toHaveLength(5);
    expect(detail.tasks.every((task) => task.state === 'completed')).toBe(true);
    expect(detail.tasks.every((task) => task.jobId !== undefined)).toBe(true);
    expect(scheduler.calls.filter((call) => call.command === 'sbatch')).toHaveLength(5);

    // Every metric carries immutable Provenance naming the Slurm executor and
    // its scheduler Job id; raw scheduler state never leaks into Task state.
    expect(detail.metrics).toHaveLength(5);
    const jobIds = new Set(detail.tasks.map((task) => task.jobId));
    for (const metric of detail.metrics) {
      expect(metric.provenance.executor.kind).toBe('slurm');
      expect(jobIds.has(metric.provenance.executor.jobId)).toBe(true);
    }
    for (const task of detail.tasks) {
      expect(['completed']).toContain(task.state);
      const logs = await readJson<TaskLogsResponse>(
        await getJson(`${handle.url}/api/runs/${created.run.id}/tasks/${task.id}/logs`, cookie),
      );
      expect(logs.available).toBe(true);
      expect(logs.lines.join('\n')).toContain('node completed');
      expect(readFileSync(join(projectRoot, task.logsPath!), 'utf8')).toContain('slurm_job=');
    }
  });
});
