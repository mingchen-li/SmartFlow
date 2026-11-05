import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeFailureKind } from '@sflow/domain';
import {
  SlurmExecutor,
  type PollResult,
  type TaskSpec,
} from '@sflow/orchestrator';
import { FakeCommandRunner } from './slurm-fake';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Raw Slurm states exercised by the contract tests. */
const QUEUED_STATES = ['PENDING', 'CONFIGURING'] as const;
const RUNNING_STATES = ['RUNNING', 'COMPLETING'] as const;

interface ExecutorFixture {
  executor: SlurmExecutor;
  runner: FakeCommandRunner;
  jobsDir: string;
  taskDir: string;
}

function makeFixture(): ExecutorFixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sflow-slurm-'));
  roots.push(projectRoot);
  const jobsDir = join(projectRoot, '.sflow', 'executor');
  const taskDir = join(projectRoot, '.sflow', 'runs', 'run-1', 'tasks', 'task-1');
  mkdirSync(taskDir, { recursive: true });
  const runner = new FakeCommandRunner();
  const executor = new SlurmExecutor({ jobsDir, runner });
  return { executor, runner, jobsDir, taskDir };
}

function specFor(taskDir: string, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    attempt: 1,
    manifestId: 'design-node',
    manifestVersion: '1.2.0',
    parameters: { seed: 7 },
    fileReferences: [],
    inputs: {},
    resources: { cpu: 1, memory: '8Gi', walltimeMinutes: 30 },
    environment: {
      kind: 'container',
      image: 'ghcr.io/sflow/nodes/design-node:1.2.0',
      command: ['python', '/opt/sflow/node.py'],
      variables: { SFLOW_SEED: '7' },
    },
    taskDir,
    ...overrides,
  };
}

async function waitForTerminal(
  executor: SlurmExecutor,
  jobId: string,
): Promise<PollResult> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await executor.poll(jobId);
    if (['completed', 'failed', 'canceled'].includes(result.state)) return result;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not finish.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SlurmExecutor submission', () => {
  it('submits one parsable sbatch Job per Task running the declared container environment', async () => {
    const { executor, runner, jobsDir, taskDir } = makeFixture();

    const submitted = await executor.submit(specFor(taskDir));

    expect(submitted.jobId).toBe('1001');
    const submissions = runner.calls.filter((call) => call.command === 'sbatch');
    expect(submissions).toHaveLength(1);
    const args = submissions[0].args;
    expect(args).toContain('--parsable');
    expect(args).toContain('--cpus-per-task=1');
    expect(args).toContain('--mem=8192M');
    expect(args).toContain('--time=30');

    const scriptPath = args.find((value) => value.endsWith('.slurm.sh'));
    expect(scriptPath).toBeDefined();
    const script = readFileSync(scriptPath!, 'utf8');
    expect(script).toContain('apptainer');
    expect(script).toContain("exec --containall 'ghcr.io/sflow/nodes/design-node:1.2.0'");
    expect(script).toContain("'python' '/opt/sflow/node.py'");
    expect(script).toContain("export SFLOW_SEED='7'");
    expect(script).toContain("export SFLOW_TASK_ID='task-1'");
    expect(script).toContain(`export SFLOW_TASK_DIR='${taskDir}'`);

    const persisted = JSON.parse(readFileSync(join(jobsDir, '1001.json'), 'utf8'));
    expect(persisted).toMatchObject({
      executor: 'slurm',
      jobId: '1001',
      runId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      attempt: 1,
      state: 'queued',
      cancelRequested: false,
    });

    const second = await executor.submit(
      specFor(taskDir, { taskId: 'task-2', nodeId: 'node-2' }),
    );
    expect(second.jobId).toBe('1002');
    expect(runner.calls.filter((call) => call.command === 'sbatch')).toHaveLength(2);
  });
});

describe('SlurmExecutor state mapping', () => {
  it.each(QUEUED_STATES)('maps scheduler state %s to queued', async (rawState) => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, rawState);

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('queued');
    expect(polled.failureKind).toBeUndefined();
  });

  it.each(RUNNING_STATES)('maps scheduler state %s to running', async (rawState) => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, rawState);
    runner.writeJobLog(jobId, 'partial log line\n');

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('running');
    expect(polled.logs).toEqual(['partial log line']);
  });

  it('maps COMPLETED to completed, collects logs, and reads the Node result contract', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'COMPLETED', '0:0');
    runner.writeJobLog(jobId, `slurm_job=${jobId}\nanswer=42\n`);
    runner.writeResult(jobId, {
      outputs: [
        {
          portId: 'designs',
          value: { count: 1 },
          artifacts: [
            {
              name: 'design.pdb',
              relativePath: 'design.pdb',
              mediaType: 'chemical/x-pdb',
              sha256: 'a'.repeat(64),
              size: 12,
            },
          ],
        },
      ],
      metrics: [
        {
          spec: {
            id: 'confidence',
            name: 'Confidence',
            description: 'Predicted confidence.',
            valueType: 'number',
          },
          value: 0.9,
          schema: { namespace: 'sflow.test', name: 'confidence', version: '1.0.0' },
        },
      ],
    });

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('completed');
    expect(polled.exitCode).toBe(0);
    expect(polled.logs).toEqual([`slurm_job=${jobId}`, 'answer=42']);
    expect(readFileSync(join(taskDir, 'logs.txt'), 'utf8')).toContain(`slurm_job=${jobId}`);
    expect(polled.result).toMatchObject({
      logsPath: join(taskDir, 'logs.txt'),
      outputs: [{ portId: 'designs', value: { count: 1 } }],
      metrics: [{ value: 0.9 }],
    });
    expect(polled.result?.outputs[0].artifacts[0]).toMatchObject({
      sha256: 'a'.repeat(64),
      size: 12,
    });

    // A terminal Job is reported from persisted state without extra scheduler calls.
    const schedulerCalls = runner.calls.length;
    const again = await executor.poll(jobId);
    expect(again.state).toBe('completed');
    expect(runner.calls.length).toBe(schedulerCalls);
  });

  it.each<[string, NodeFailureKind]>([
    ['FAILED', 'exit-code'],
    ['NODE_FAIL', 'transient'],
    ['BOOT_FAIL', 'transient'],
    ['OUT_OF_MEMORY', 'transient'],
    ['PREEMPTED', 'transient'],
  ])('maps scheduler state %s to failed with failureKind %s', async (rawState, failureKind) => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, rawState, '1:0');

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('failed');
    expect(polled.failureKind).toBe(failureKind);
    expect(polled.exitCode).toBe(1);
    expect(polled.error).toContain(rawState);
  });

  it('maps TIMEOUT to a failed timeout', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'TIMEOUT', '0:15');

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('failed');
    expect(polled.failureKind).toBe('timeout');
  });

  it('maps CANCELLED to canceled without exposing the raw scheduler state as Task state', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'CANCELLED', '0:15');

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('canceled');
    expect(polled.exitCode).toBe(130);
    expect(polled.failureKind).toBeUndefined();
  });

  it('treats a completed Job with a non-zero exit code as an exit-code failure', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'COMPLETED', '3:0');

    const polled = await executor.poll(jobId);

    expect(polled.state).toBe('failed');
    expect(polled.failureKind).toBe('exit-code');
    expect(polled.exitCode).toBe(3);
  });
});

describe('SlurmExecutor cancellation', () => {
  it('requests scancel for a running Job and reports it as canceled', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'RUNNING');
    expect((await executor.poll(jobId)).state).toBe('running');

    await executor.cancel(jobId);

    const scancelCalls = runner.calls.filter((call) => call.command === 'scancel');
    expect(scancelCalls).toHaveLength(1);
    expect(scancelCalls[0].args).toContain(jobId);

    const polled = await executor.poll(jobId);
    expect(polled.state).toBe('canceled');
    expect(polled.exitCode).toBe(130);

    // Cancellation is idempotent and never issues a second scancel.
    await executor.cancel(jobId);
    expect(runner.calls.filter((call) => call.command === 'scancel')).toHaveLength(1);
  });

  it('does not ask the scheduler to cancel an already completed Job', async () => {
    const { executor, runner, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'COMPLETED', '0:0');
    runner.writeResult(jobId, { outputs: [], metrics: [] });
    expect((await executor.poll(jobId)).state).toBe('completed');

    await executor.cancel(jobId);

    expect(runner.calls.filter((call) => call.command === 'scancel')).toHaveLength(0);
    expect((await executor.poll(jobId)).state).toBe('completed');
  });
});

describe('SlurmExecutor restart reconciliation', () => {
  it('reconnects to submitted Jobs after a restart and adopts scheduler completion without resubmitting', async () => {
    const { executor, runner, jobsDir, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'RUNNING');
    expect((await executor.poll(jobId)).state).toBe('running');

    // A new Server process constructs a fresh executor over the same persisted
    // job directory. It sees the Job still running.
    const restarted = new SlurmExecutor({ jobsDir, runner });
    const first = await restarted.reconcile('run-1');
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({
      jobId,
      runId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      attempt: 1,
      state: 'running',
    });
    expect(runner.calls.filter((call) => call.command === 'sbatch')).toHaveLength(1);

    // The Job finishes while SFlow is down.
    runner.setState(jobId, 'COMPLETED', '0:0');
    runner.writeJobLog(jobId, 'finished while down\n');
    runner.writeResult(jobId, { outputs: [], metrics: [] });

    const second = await restarted.reconcile('run-1');
    expect(second.jobs[0].state).toBe('completed');
    expect(runner.calls.filter((call) => call.command === 'sbatch')).toHaveLength(1);

    // The completed executor record carries the collected result for adoption.
    const polled = await restarted.poll(jobId);
    expect(polled.state).toBe('completed');
    expect(polled.result).toMatchObject({ outputs: [], metrics: [] });
    expect(polled.logs).toEqual(['finished while down']);

    // Reconciliation is idempotent and never duplicates scheduler work.
    const third = await restarted.reconcile('run-1');
    expect(third.jobs[0].state).toBe('completed');
    expect(runner.calls.filter((call) => call.command === 'sbatch')).toHaveLength(1);
  });

  it('returns only Jobs belonging to the requested Run', async () => {
    const { executor, runner, jobsDir, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    const other = await executor.submit(
      specFor(taskDir, { runId: 'run-2', taskId: 'task-2', nodeId: 'node-2' }),
    );
    runner.setState(jobId, 'COMPLETED', '0:0');
    runner.writeResult(jobId, { outputs: [], metrics: [] });

    const result = await executor.reconcile('run-1');

    expect(result.jobs.map((job) => job.jobId)).toEqual([jobId]);
    expect(result.jobs.map((job) => job.jobId)).not.toContain(other.jobId);
  });

  it('reports persisted terminal Jobs without querying the scheduler again', async () => {
    const { executor, runner, jobsDir, taskDir } = makeFixture();
    const { jobId } = await executor.submit(specFor(taskDir));
    runner.setState(jobId, 'FAILED', '2:0');
    expect((await executor.poll(jobId)).state).toBe('failed');

    const restarted = new SlurmExecutor({ jobsDir, runner });
    const callsBefore = runner.calls.length;
    const result = await restarted.reconcile('run-1');

    expect(result.jobs[0]).toMatchObject({
      state: 'failed',
      exitCode: 2,
      failureKind: 'exit-code',
    });
    expect(runner.calls.length).toBe(callsBefore);
  });
});
