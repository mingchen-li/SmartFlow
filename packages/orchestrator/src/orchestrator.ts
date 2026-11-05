import { randomUUID } from 'node:crypto';
import {
  TASK_TERMINAL_STATES,
  type Provenance,
  type Run,
  type RunNodeSnapshot,
  type RunSnapshot,
  type Task,
  type TaskState,
  type WorkflowEdge,
} from '@sflow/domain';
import type {
  ComputeExecutor,
  ExecutorTaskResult,
  OrchestratorStore,
  PollResult,
  TaskOutputRecord,
  TaskSpec,
} from './contracts';

export interface OrchestratorOptions {
  store: OrchestratorStore;
  executor: ComputeExecutor;
  /** Poll cadence while a Compute Executor job is active. */
  pollIntervalMs?: number;
  clock?: () => Date;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface PlannedNode {
  node: RunNodeSnapshot;
  incoming: WorkflowEdge[];
}

const TERMINAL_STATES = new Set<TaskState>(TASK_TERMINAL_STATES);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The Node execution failed.';
}

/**
 * Plans Tasks in dependency order from the immutable Run snapshot. Every Node
 * becomes one atomic Task attempt; data and control edges both constrain
 * ordering, and the workflow's original Node order breaks ties.
 */
export function planRun(snapshot: RunSnapshot): PlannedNode[] {
  const nodes = snapshot.nodes;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const incoming = new Map<string, WorkflowEdge[]>(
    nodes.map((node) => [node.nodeId, []]),
  );
  const outgoing = new Map<string, string[]>(
    nodes.map((node) => [node.nodeId, []]),
  );
  const indegree = new Map<string, number>(nodes.map((node) => [node.nodeId, 0]));

  for (const edge of snapshot.workflow.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    incoming.get(edge.target)!.push(edge);
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }

  const indexOf = new Map(nodes.map((node, index) => [node.nodeId, index]));
  const ready = nodes
    .map((_, index) => index)
    .filter((index) => indegree.get(nodes[index].nodeId) === 0);
  ready.sort((left, right) => left - right);

  const ordered: RunNodeSnapshot[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    const node = nodes[current];
    ordered.push(node);
    for (const target of outgoing.get(node.nodeId) ?? []) {
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(indexOf.get(target)!);
        ready.sort((left, right) => left - right);
      }
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error('The Run snapshot contains a dependency cycle and cannot be scheduled.');
  }

  return ordered.map((node) => ({
    node,
    incoming: incoming.get(node.nodeId)!,
  }));
}

/**
 * Deterministic Orchestrator for the immutable Run snapshot.
 *
 * It creates one Task per atomic Node attempt, schedules in dependency order,
 * drives the Compute Executor contract, and records Task transitions, logs
 * availability, immutable content-addressed Artifacts, typed Metrics with
 * Provenance, and append-only events through the persistence seam.
 */
export class Orchestrator {
  private readonly store: OrchestratorStore;
  private readonly executor: ComputeExecutor;
  private readonly pollIntervalMs: number;
  private readonly clock: () => Date;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Starts a Run in the background. Safe to call more than once per Run. */
  start(runId: string): void {
    if (this.active.has(runId)) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const promise = this.run(runId, { signal: controller.signal }).catch(() => undefined);
    this.active.set(runId, promise);
    void promise.finally(() => {
      if (this.active.get(runId) === promise) this.active.delete(runId);
      if (this.controllers.get(runId) === controller) this.controllers.delete(runId);
    });
  }

  /** Resolves once a started Run finishes (or immediately if it is not active). */
  async whenIdle(runId: string): Promise<void> {
    await this.active.get(runId);
  }

  /** Aborts active Run execution, e.g. when the Project Server closes. */
  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }

  /**
   * Executes a Run to a terminal state. An unexpected failure fails the Run and
   * rethrows; an ordinary Node failure is persisted and resolves normally.
   */
  async run(runId: string, options: RunOptions = {}): Promise<void> {
    try {
      await this.executeRun(runId, options.signal);
    } catch (error) {
      this.markRunFailed(runId, errorMessage(error));
      throw error;
    }
  }

  private async executeRun(runId: string, signal?: AbortSignal): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown Run "${runId}".`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return;
    }

    const plan = planRun(run.snapshot);
    const tasks = this.ensureTasks(run, plan);

    if (signal?.aborted) {
      this.markRunCanceled(runId);
      return;
    }

    this.store.updateRunStatus(runId, 'running');
    this.store.appendEvent({
      runId,
      type: 'run.started',
      payload: { nodeCount: plan.length },
      createdAt: this.now(),
    });

    const outputsByNode = new Map<string, TaskOutputRecord[]>();
    for (const task of tasks.values()) {
      if (task.state !== 'completed') continue;
      const outputs = this.store.getTaskOutputs(task.id);
      if (outputs) outputsByNode.set(task.nodeId, outputs);
    }

    for (const planned of plan) {
      const task = tasks.get(planned.node.nodeId)!;
      if (task.state === 'completed') continue;

      if (signal?.aborted) {
        this.markRunCanceled(runId);
        return;
      }

      const inputs = this.resolveInputs(planned, outputsByNode);
      const upstreamArtifacts = this.upstreamArtifactIds(planned, outputsByNode);
      const outcome = await this.executeTask(
        run,
        task,
        planned,
        inputs,
        upstreamArtifacts,
        signal,
      );
      if (outcome.type !== 'completed') return;
      outputsByNode.set(task.nodeId, outcome.outputs);
    }

    this.store.updateRunStatus(runId, 'completed');
    this.store.appendEvent({
      runId,
      type: 'run.completed',
      payload: { taskCount: plan.length },
      createdAt: this.now(),
    });
  }

  /** Creates the queued Task rows up front, in dependency order. */
  private ensureTasks(run: Run, plan: PlannedNode[]): Map<string, Task> {
    const existing = this.store.listTasks(run.id);
    const tasks = new Map<string, Task>();
    for (const node of plan) {
      const task =
        existing.find((candidate) => candidate.nodeId === node.node.nodeId && candidate.attempt === 1) ??
        this.createTask(run, node.node);
      tasks.set(node.node.nodeId, task);
    }
    return tasks;
  }

  private createTask(run: Run, node: RunNodeSnapshot): Task {
    const task = this.store.createTask({
      runId: run.id,
      nodeId: node.nodeId,
      label: node.label,
      manifestId: node.manifestId,
      manifestVersion: node.manifestVersion,
      attempt: 1,
      state: 'queued',
      createdAt: this.now(),
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.queued',
      payload: {
        nodeId: node.nodeId,
        attempt: task.attempt,
        label: node.label,
        manifestId: node.manifestId,
        manifestVersion: node.manifestVersion,
      },
      createdAt: this.now(),
    });
    return task;
  }

  private resolveInputs(
    planned: PlannedNode,
    outputsByNode: Map<string, TaskOutputRecord[]>,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const edge of planned.incoming) {
      const records = outputsByNode.get(edge.source) ?? [];
      const record = records.find((output) => output.portId === edge.sourcePort);
      // Control ports do not carry values; a dependency completion is the
      // signal, represented as `true`.
      inputs[edge.targetPort] = record ? record.value : true;
    }
    return inputs;
  }

  private upstreamArtifactIds(
    planned: PlannedNode,
    outputsByNode: Map<string, TaskOutputRecord[]>,
  ): string[] {
    const ids = new Set<string>();
    for (const edge of planned.incoming) {
      for (const output of outputsByNode.get(edge.source) ?? []) {
        for (const artifactId of output.artifactIds) ids.add(artifactId);
      }
    }
    return [...ids].sort();
  }

  private async executeTask(
    run: Run,
    task: Task,
    planned: PlannedNode,
    inputs: Record<string, unknown>,
    upstreamArtifacts: string[],
    signal?: AbortSignal,
  ): Promise<{ type: 'completed'; outputs: TaskOutputRecord[] } | { type: 'stopped' }> {
    const node = planned.node;
    const logsPath = `${this.store.taskNamespacePath(run.id, task.id)}/logs.txt`;
    const startedAt = this.now();
    this.store.updateTask(task.id, {
      state: 'running',
      logsPath,
      startedAt,
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.running',
      payload: { nodeId: node.nodeId, attempt: task.attempt },
      createdAt: startedAt,
    });

    const spec: TaskSpec = {
      runId: run.id,
      taskId: task.id,
      nodeId: node.nodeId,
      attempt: task.attempt,
      manifestId: node.manifestId,
      manifestVersion: node.manifestVersion,
      parameters: node.parameters,
      fileReferences: node.fileReferences,
      inputs,
      resources: node.resources,
      environment: node.environment,
      taskDir: this.store.taskNamespace(run.id, task.id),
    };

    let jobId: string;
    try {
      const submitted = await this.executor.submit(spec, { signal });
      jobId = submitted.jobId;
      this.store.updateTask(task.id, { jobId });
    } catch (error) {
      return this.failTask(run, task, errorMessage(error));
    }

    let poll: PollResult;
    try {
      poll = await this.executor.poll(jobId);
      let cancelRequested = false;
      while (!TERMINAL_STATES.has(poll.state)) {
        if (signal?.aborted && !cancelRequested) {
          cancelRequested = true;
          await this.executor.cancel(jobId).catch(() => undefined);
        }
        await delay(this.pollIntervalMs);
        poll = await this.executor.poll(jobId);
      }
    } catch (error) {
      return this.failTask(run, task, errorMessage(error), jobId);
    }

    if (poll.state === 'canceled') {
      const completedAt = this.now();
      this.store.updateTask(task.id, {
        state: 'canceled',
        exitCode: poll.exitCode ?? 130,
        completedAt,
      });
      this.store.appendEvent({
        runId: run.id,
        taskId: task.id,
        type: 'task.canceled',
        payload: { exitCode: poll.exitCode ?? 130 },
        createdAt: completedAt,
      });
      this.markRunCanceled(run.id, task.id);
      return { type: 'stopped' };
    }

    if (poll.state === 'failed') {
      return this.failTask(
        run,
        task,
        poll.error ?? 'The Node execution failed.',
        jobId,
        poll.exitCode ?? 1,
      );
    }

    try {
      if (!poll.result) {
        throw new Error(`Executor job "${jobId}" completed without a Task result.`);
      }
      const outputs = this.recordTaskResult(
        run,
        task,
        planned,
        jobId,
        poll.result,
        upstreamArtifacts,
      );
      this.store.saveTaskOutputs(task.id, outputs);
      const completedAt = this.now();
      this.store.updateTask(task.id, {
        state: 'completed',
        exitCode: poll.exitCode ?? 0,
        completedAt,
      });
      this.store.appendEvent({
        runId: run.id,
        taskId: task.id,
        type: 'task.completed',
        payload: { exitCode: poll.exitCode ?? 0 },
        createdAt: completedAt,
      });
      return { type: 'completed', outputs };
    } catch (error) {
      return this.failTask(run, task, errorMessage(error), jobId);
    }
  }

  private recordTaskResult(
    run: Run,
    task: Task,
    planned: PlannedNode,
    jobId: string,
    result: ExecutorTaskResult,
    upstreamArtifacts: string[],
  ): TaskOutputRecord[] {
    const node = planned.node;
    const createdAt = this.now();
    const provenance: Provenance = {
      id: `provenance-${randomUUID()}`,
      runId: run.id,
      taskId: task.id,
      nodeId: node.nodeId,
      attempt: task.attempt,
      manifestId: node.manifestId,
      manifestVersion: node.manifestVersion,
      inputs: {
        artifacts: [...upstreamArtifacts],
        fileReferences: node.fileReferences,
      },
      parameters: node.parameters,
      environment: node.environment,
      executor: { kind: this.executor.kind, jobId },
      createdAt,
    };

    const outputs: TaskOutputRecord[] = [];
    for (const output of result.outputs) {
      const artifactIds: string[] = [];
      for (const artifact of output.artifacts) {
        const recorded = this.store.recordArtifact({
          runId: run.id,
          taskId: task.id,
          nodeId: node.nodeId,
          name: artifact.name,
          mediaType: artifact.mediaType,
          path: `${this.store.taskNamespacePath(run.id, task.id)}/${artifact.relativePath}`,
          sha256: artifact.sha256,
          size: artifact.size,
          ...(artifact.schema ? { schema: artifact.schema } : {}),
          provenance,
          createdAt,
        });
        artifactIds.push(recorded.id);
        this.store.appendEvent({
          runId: run.id,
          taskId: task.id,
          type: 'artifact.recorded',
          payload: {
            artifactId: recorded.id,
            name: recorded.name,
            sha256: recorded.sha256,
            size: recorded.size,
            mediaType: recorded.mediaType,
          },
          createdAt,
        });
      }
      outputs.push({
        portId: output.portId,
        ...(output.value !== undefined ? { value: output.value } : {}),
        artifactIds,
      });
    }

    for (const metric of result.metrics) {
      const recorded = this.store.recordMetric({
        runId: run.id,
        taskId: task.id,
        nodeId: node.nodeId,
        metricId: metric.spec.id,
        name: metric.spec.name,
        meaning: metric.spec.description ?? metric.spec.name,
        valueType: metric.spec.valueType,
        value: metric.value,
        ...(metric.spec.unit ? { unit: metric.spec.unit } : {}),
        ...(metric.spec.scale ? { scale: metric.spec.scale } : {}),
        ...(metric.spec.direction ? { direction: metric.spec.direction } : {}),
        schema: metric.schema,
        provenance,
        createdAt,
      });
      this.store.appendEvent({
        runId: run.id,
        taskId: task.id,
        type: 'metric.recorded',
        payload: { metricId: recorded.metricId, value: recorded.value },
        createdAt,
      });
    }

    return outputs;
  }

  private failTask(
    run: Run,
    task: Task,
    message: string,
    jobId?: string,
    exitCode = 1,
  ): { type: 'stopped' } {
    const completedAt = this.now();
    this.store.updateTask(task.id, {
      state: 'failed',
      exitCode,
      error: message,
      ...(jobId ? { jobId } : {}),
      completedAt,
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.failed',
      payload: { exitCode, error: message },
      createdAt: completedAt,
    });
    this.markRunFailed(run.id, message, task.id);
    return { type: 'stopped' };
  }

  private markRunFailed(runId: string, message: string, taskId?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return;
    }
    this.store.updateRunStatus(runId, 'failed');
    this.store.appendEvent({
      runId,
      type: 'run.failed',
      ...(taskId ? { taskId } : {}),
      payload: { error: message },
      createdAt: this.now(),
    });
  }

  private markRunCanceled(runId: string, taskId?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return;
    }
    this.store.updateRunStatus(runId, 'canceled');
    this.store.appendEvent({
      runId,
      type: 'run.canceled',
      ...(taskId ? { taskId } : {}),
      createdAt: this.now(),
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
