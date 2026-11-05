import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  NodeImplementation,
  NodeManifest,
  NodeRegistry,
  NodeRunContext,
} from '@sflow/domain';
import {
  LocalExecutor,
  type PollResult,
  type TaskSpec,
} from '@sflow/orchestrator';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const testManifest: NodeManifest = {
  id: 'test-node',
  version: '1.0.0',
  name: 'Test node',
  description: 'A deterministic executor contract test node.',
  category: 'Test',
  type: 'test',
  inputs: [],
  outputs: [
    { id: 'out', name: 'Output', direction: 'output', kind: 'data', dataType: 'text' },
  ],
  parameters: [],
  metrics: [
    {
      id: 'answer',
      name: 'Answer',
      description: 'The deterministic answer.',
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 100 },
      direction: 'higher-is-better',
    },
  ],
  resources: { cpu: 1 },
  environment: { kind: 'container', image: 'ghcr.io/sflow/nodes/test-node:1.0.0' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
};

function registryFor(implementation: NodeImplementation): NodeRegistry {
  return {
    get: (id, version) =>
      id === implementation.manifest.id && version === implementation.manifest.version
        ? implementation
        : undefined,
    list: () => [implementation],
  };
}

function makeRoot(): { projectRoot: string; jobsDir: string; taskDir: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sflow-executor-'));
  roots.push(projectRoot);
  const taskDir = join(projectRoot, '.sflow', 'runs', 'run-1', 'tasks', 'task-1');
  mkdirSync(taskDir, { recursive: true });
  return { projectRoot, jobsDir: join(projectRoot, '.sflow', 'executor'), taskDir };
}

function specFor(taskDir: string): TaskSpec {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    attempt: 1,
    manifestId: 'test-node',
    manifestVersion: '1.0.0',
    parameters: {},
    fileReferences: [],
    inputs: {},
    resources: { cpu: 1 },
    environment: { kind: 'container', image: 'ghcr.io/sflow/nodes/test-node:1.0.0' },
    taskDir,
  };
}

async function waitForTerminal(
  executor: LocalExecutor,
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

const writingImplementation: NodeImplementation = {
  manifest: testManifest,
  run(_input, _params, context: NodeRunContext) {
    context.log('answer=42');
    context.writeFile('out.txt', 'hello artifact\n');
    return {
      outputs: [
        {
          portId: 'out',
          value: { answer: 42 },
          artifacts: [
            {
              name: 'out.txt',
              relativePath: 'out.txt',
              mediaType: 'text/plain',
              schema: { namespace: 'sflow.test', name: 'text', version: '1.0.0' },
            },
          ],
        },
      ],
      metrics: { answer: 42 },
    };
  },
};

describe('LocalExecutor contract', () => {
  it('submits, polls, and completes a deterministic Node with persisted job state', async () => {
    const { projectRoot, jobsDir, taskDir } = makeRoot();
    const executor = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(writingImplementation),
    });

    const { jobId } = await executor.submit(specFor(taskDir));
    expect(jobId).toBeTruthy();

    const result = await waitForTerminal(executor, jobId);
    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual(['node=test-node attempt=1', 'state=running', 'answer=42', 'wrote out.txt', 'state=completed']);

    const artifact = result.result?.outputs[0].artifacts[0];
    expect(artifact?.name).toBe('out.txt');
    expect(artifact?.size).toBe(15);
    expect(artifact?.sha256).toBe(
      createHash('sha256').update('hello artifact\n').digest('hex'),
    );
    expect(readFileSync(join(taskDir, 'out.txt'), 'utf8')).toBe('hello artifact\n');

    // The Manifest declares meaning, unit, and scale; the executor resolves
    // the returned value against that declaration.
    expect(result.result?.metrics).toEqual([
      {
        spec: testManifest.metrics[0],
        value: 42,
        schema: {
          namespace: 'sflow.binder.test-node',
          name: 'answer',
          version: '1.0.0',
        },
      },
    ]);

    // Job state survives the executor instance so ticket #9 can reconcile.
    const restarted = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(writingImplementation),
    });
    const reconciled = await restarted.reconcile('run-1');
    expect(reconciled.jobs).toEqual([
      expect.objectContaining({
        jobId,
        runId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        attempt: 1,
        state: 'completed',
        exitCode: 0,
      }),
    ]);
    expect(await restarted.reconcile('other-run')).toEqual({ jobs: [] });
  });

  it('persists a failed task attempt with its error and log lines', async () => {
    const { projectRoot, jobsDir, taskDir } = makeRoot();
    const failing: NodeImplementation = {
      manifest: testManifest,
      run() {
        throw new Error('synthetic prediction failure');
      },
    };
    const executor = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(failing),
    });

    const { jobId } = await executor.submit(specFor(taskDir));
    const result = await waitForTerminal(executor, jobId);

    expect(result.state).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.logs).toEqual(
      expect.arrayContaining([
        'state=running',
        'error=synthetic prediction failure',
        'state=failed',
      ]),
    );
    const persisted = JSON.parse(
      readFileSync(join(jobsDir, `${jobId}.json`), 'utf8'),
    ) as { state: string; error: string };
    expect(persisted).toMatchObject({
      state: 'failed',
      error: 'synthetic prediction failure',
    });
  });

  it('cancels through an AbortSignal and records the canceled job', async () => {
    const { projectRoot, jobsDir, taskDir } = makeRoot();
    const slow: NodeImplementation = {
      manifest: testManifest,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { outputs: [], metrics: {} };
      },
    };
    const executor = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(slow),
    });

    const controller = new AbortController();
    const { jobId } = await executor.submit(specFor(taskDir), {
      signal: controller.signal,
    });
    controller.abort();

    const result = await waitForTerminal(executor, jobId);
    expect(result.state).toBe('canceled');
    expect(result.exitCode).toBe(130);
    expect((await executor.poll(jobId)).state).toBe('canceled');
  });

  it('rejects attempts to overwrite a Task output file', async () => {
    const { projectRoot, jobsDir, taskDir } = makeRoot();
    const overwriting: NodeImplementation = {
      manifest: testManifest,
      run(_input, _params, context) {
        context.writeFile('out.txt', 'first\n');
        context.writeFile('out.txt', 'second\n');
        return { outputs: [], metrics: {} };
      },
    };
    const executor = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(overwriting),
    });

    const { jobId } = await executor.submit(specFor(taskDir));
    const result = await waitForTerminal(executor, jobId);
    expect(result.state).toBe('failed');
    expect(result.result).toBeUndefined();
    expect(readFileSync(join(taskDir, 'out.txt'), 'utf8')).toBe('first\n');
  });

  it('fails a submission when no implementation is registered for the Manifest version', async () => {
    const { projectRoot, jobsDir, taskDir } = makeRoot();
    const executor = new LocalExecutor({
      projectRoot,
      jobsDir,
      registry: registryFor(writingImplementation),
    });

    await expect(
      executor.submit({ ...specFor(taskDir), manifestVersion: '2.0.0' }),
    ).rejects.toThrow(/test-node@2\.0\.0/);
    await expect(executor.poll('missing-job')).rejects.toThrow(/missing-job/);
  });
});
