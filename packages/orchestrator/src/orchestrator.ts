import { randomUUID } from 'node:crypto';
import {
  shouldRetryTask,
  TASK_TERMINAL_STATES,
  type NodeFailureKind,
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
  ReconcileJob,
  TaskOutputRecord,
  TaskSpec,
} from './contracts';

export interface OrchestratorOptions {
  store: OrchestratorStore;
  executor: ComputeExecutor;
  /** Poll cadence while a Compute Executor job is active. */
  pollIntervalMs?: number;
  clock?: () => Date;
  /**
   * Waits out a retry backoff. Returns false when the Run was canceled while
   * waiting. Tests inject a deterministic implementation.
   */
  retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export interface PlannedNode {
  node: RunNodeSnapshot;
  incoming: WorkflowEdge[];
}

type TaskOutcome =
  | { type: 'completed'; outputs: TaskOutputRecord[] }
  | { type: 'stopped' }
  | { type: 'retry'; task: Task; backoffSeconds: number };

export type OrchestratorErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_ACTIVE'
  | 'RUN_COMPLETED'
  | 'TASK_NOT_FOUND'
  | 'TASK_COMPLETED'
  | 'TASK_NOT_TERMINAL'
  | 'TASK_SUPERSEDED';

/** A rejected cancellation/rerun command, mapped to HTTP 409 by the Server. */
export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;

  constructor(code: OrchestratorErrorCode, message: string) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}

const TERMINAL_STATES = new Set<TaskState>(TASK_TERMINAL_STATES);
const TERMINAL_RUN_STATES = new Set<Run['status']>(['completed', 'failed', 'canceled']);

/**
 * A Task attempt that was still queued or running when the Server process
 * stopped is failed with this message; resuming work creates a new attempt, so
 * completed scientific records are never rewritten or executed twice.
 */
const INTERRUPTED_MESSAGE = 'The Server restarted while this Task attempt was running.';
const INTERRUPTED_EXIT_CODE = 137;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Abortable retry backoff; resolves false if the Run is canceled first. */
function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (milliseconds <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  private readonly retryWait: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly canceling = new Set<string>();
  private closing = false;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.clock = options.clock ?? (() => new Date());
    this.retryWait = options.retryWait ?? waitForRetry;
  }

  /**
   * Rebuilds active Run state from persisted Project and executor records, then
   * resumes execution. Called by the Server on startup. Safe to call on
   * repeated startups: terminal Runs and completed Tasks are left untouched.
   */
  async reconcileAll(): Promise<void> {
    if (this.closing) return;
    for (const run of this.store.listActiveRuns()) {
      if (this.closing) return;
      await this.reconcileRun(run.id);
    }
  }

  /** Starts a Run in the background. Safe to call more than once per Run. */
  start(runId: string): void {
    if (this.closing || this.active.has(runId)) return;
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

  /**
   * Stops monitoring active Runs when the Project Server closes. Persisted Run,
   * Task, and executor job state is deliberately left non-terminal so the next
   * Server process can reconcile and resume it; executor work is not canceled.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }

  /**
   * Executes a Run to a terminal state. An unexpected failure fails the Run and
   * rethrows; an ordinary Node failure is persisted and resolves normally.
   */
  async run(runId: string, options: RunOptions = {}): Promise<void> {
    let ownedController: AbortController | undefined;
    let signal = options.signal;
    if (!signal) {
      ownedController = new AbortController();
      signal = ownedController.signal;
      this.controllers.set(runId, ownedController);
    }
    try {
      await this.executeRun(runId, signal);
    } catch (error) {
      if (this.closing) return;
      this.markRunFailed(runId, errorMessage(error));
      throw error;
    } finally {
      if (ownedController && this.controllers.get(runId) === ownedController) {
        this.controllers.delete(runId);
      }
    }
  }

  private async reconcileRun(runId: string): Promise<void> {
    // Repeated startups (or a second reconcile call) must not interrupt work
    // this process is already monitoring.
    if (this.active.has(runId)) return;
    const run = this.store.getRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;

    const plan = planRun(run.snapshot);
    const tasks = this.ensureTasks(run, plan);
    const jobs = (await this.executor.reconcile(run.id)).jobs;
    const outputsByNode = new Map<string, TaskOutputRecord[]>();
    for (const task of tasks.values()) {
      if (task.state !== 'completed') continue;
      const outputs = this.store.getTaskOutputs(task.id);
      if (outputs) outputsByNode.set(task.nodeId, outputs);
    }

    for (const planned of plan) {
      if (this.closing) return;
      const task = tasks.get(planned.node.nodeId)!;
      if (task.state === 'completed') continue;
      if (task.state === 'failed') {
        // The Server may have stopped after persisting a retryable failure but
        // before scheduling the next attempt. Recovery uses the same immutable
        // Manifest policy; canceled or non-retryable work still fails the Run.
        const retry = this.scheduleRetry(
          run,
          planned.node,
          task,
          task.failureKind ?? 'unknown',
        );
        if (retry) {
          tasks.set(planned.node.nodeId, retry.task);
          continue;
        }
        this.markRunFailed(run.id, task.error ?? 'The Task failed.', task.id);
        return;
      }
      if (task.state === 'canceled') {
        this.markRunCanceled(run.id, task.id);
        return;
      }

      const job = this.findExecutorJob(task, jobs);
      if (job && TERMINAL_STATES.has(job.state)) {
        if (job.state === 'completed') {
          const adopted = await this.adoptCompletedJob(
            run,
            task,
            planned,
            job.jobId,
            outputsByNode,
          );
          if (!adopted) return;
          tasks.set(planned.node.nodeId, this.store.getTask(task.id)!);
          continue;
        }
        if (job.state === 'failed') {
          const outcome = this.failAttempt(
            run,
            planned,
            task,
            job.error ?? 'The Node execution failed.',
            job.failureKind ?? 'unknown',
            job.jobId,
            job.exitCode ?? 1,
          );
          if (outcome.type === 'retry') {
            tasks.set(planned.node.nodeId, outcome.task);
            continue;
          }
          return;
        }
        const completedAt = this.now();
        this.store.updateTask(task.id, {
          state: 'canceled',
          exitCode: job.exitCode ?? 130,
          completedAt,
        });
        this.store.appendEvent({
          runId: run.id,
          taskId: task.id,
          type: 'task.canceled',
          payload: { exitCode: job.exitCode ?? 130 },
          createdAt: completedAt,
        });
        this.markRunCanceled(run.id, task.id);
        return;
      }

      // A queued Task with no executor job never started before shutdown.
      if (task.state === 'queued' && !job) continue;
      tasks.set(planned.node.nodeId, this.interruptTask(run, planned.node, task));
    }

    if ([...tasks.values()].every((task) => task.state === 'completed')) {
      this.completeRun(run.id, plan.length);
      return;
    }

    this.start(run.id);
  }

  /** Finds the persisted executor record for the Task attempt, if any. */
  private findExecutorJob(task: Task, jobs: ReconcileJob[]): ReconcileJob | undefined {
    if (task.jobId) {
      const byId = jobs.find((job) => job.jobId === task.jobId);
      if (byId) return byId;
    }
    return jobs
      .filter((job) => job.taskId === task.id && job.attempt === task.attempt)
      .sort((left, right) => right.jobId.localeCompare(left.jobId))[0];
  }

  /**
   * Closes an interrupted attempt as failed history and schedules a fresh
   * attempt for the same Node. The interrupted attempt's logs and records stay
   * visible; the resumed attempt is what reports the final scientific result.
   */
  private interruptTask(run: Run, node: RunNodeSnapshot, task: Task): Task {
    const completedAt = this.now();
    this.store.updateTask(task.id, {
      state: 'failed',
      exitCode: INTERRUPTED_EXIT_CODE,
      error: INTERRUPTED_MESSAGE,
      completedAt,
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.failed',
      payload: {
        nodeId: node.nodeId,
        attempt: task.attempt,
        exitCode: INTERRUPTED_EXIT_CODE,
        error: INTERRUPTED_MESSAGE,
        interrupted: true,
      },
      createdAt: completedAt,
    });
    return this.createTask(run, node, task.attempt + 1);
  }

  /**
   * Adopts an executor job that reached a terminal completed state while the
   * Server was not monitoring it. The persisted executor result is recorded
   * exactly once through the same path as a live completion.
   */
  private async adoptCompletedJob(
    run: Run,
    task: Task,
    planned: PlannedNode,
    jobId: string,
    outputsByNode: Map<string, TaskOutputRecord[]>,
  ): Promise<boolean> {
    const poll = await this.executor.poll(jobId);
    if (poll.state !== 'completed' || !poll.result) {
      this.failAttempt(
        run,
        planned,
        task,
        poll.error ?? `Executor job "${jobId}" completed without a Task result.`,
        poll.failureKind ?? 'unknown',
        jobId,
        poll.exitCode ?? 1,
      );
      return false;
    }

    const outputs = this.completeTaskFromResult(
      run,
      task,
      planned,
      jobId,
      poll.result,
      this.upstreamArtifactIds(planned, outputsByNode),
    );
    outputsByNode.set(task.nodeId, outputs);
    return true;
  }

  private completeRun(runId: string, taskCount: number): void {
    const run = this.store.getRun(runId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;
    this.store.updateRunStatus(runId, 'completed');
    this.store.appendEvent({
      runId,
      type: 'run.completed',
      payload: { taskCount },
      createdAt: this.now(),
    });
  }

  private async executeRun(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown Run "${runId}".`);
    if (TERMINAL_RUN_STATES.has(run.status)) return;

    const plan = planRun(run.snapshot);
    const tasks = this.ensureTasks(run, plan);

    if (this.closing) return;
    if (signal.aborted) {
      this.markRunCanceled(runId);
      return;
    }

    const wasQueued = run.status === 'queued';
    this.store.updateRunStatus(runId, 'running');
    if (wasQueued) {
      this.store.appendEvent({
        runId,
        type: 'run.started',
        payload: { nodeCount: plan.length },
        createdAt: this.now(),
      });
    }

    const outputsByNode = new Map<string, TaskOutputRecord[]>();
    for (const task of tasks.values()) {
      if (task.state !== 'completed') continue;
      const outputs = this.store.getTaskOutputs(task.id);
      if (outputs) outputsByNode.set(task.nodeId, outputs);
    }

    for (const planned of plan) {
      let task = tasks.get(planned.node.nodeId)!;
      if (task.state === 'completed') continue;

      if (this.closing) return;

      if (task.state === 'failed') {
        this.markRunFailed(runId, task.error ?? 'The Task failed.', task.id);
        return;
      }
      if (task.state === 'canceled') {
        this.markRunCanceled(runId, task.id);
        return;
      }

      const inputs = this.resolveInputs(planned, outputsByNode);
      const upstreamArtifacts = this.upstreamArtifactIds(planned, outputsByNode);

      for (;;) {
        if (this.closing) return;
        if (signal.aborted) {
          this.markRunCanceled(runId);
          return;
        }

        const outcome = await this.executeTask(
          run,
          task,
          planned,
          inputs,
          upstreamArtifacts,
          signal,
        );
        if (outcome.type === 'completed') {
          outputsByNode.set(task.nodeId, outcome.outputs);
          break;
        }
        if (outcome.type === 'stopped') return;

        // A retryable failure is persisted history; the next attempt is a new
        // Task row and waits out the Manifest backoff before executing.
        const retryAllowed = await this.retryWait(
          outcome.backoffSeconds * 1_000,
          signal,
        );
        if (this.closing) return;
        if (!retryAllowed || signal.aborted) {
          this.markRunCanceled(runId);
          return;
        }
        task = outcome.task;
      }
    }

    this.completeRun(runId, plan.length);
  }

  /**
   * Returns the current (highest-attempt) Task per Node, creating the initial
   * queued rows in dependency order. Earlier attempts remain as history.
   */
  private ensureTasks(run: Run, plan: PlannedNode[]): Map<string, Task> {
    const existing = this.store.listTasks(run.id);
    const tasks = new Map<string, Task>();
    for (const node of plan) {
      const latest = existing
        .filter((candidate) => candidate.nodeId === node.node.nodeId)
        .sort((left, right) => right.attempt - left.attempt)[0];
      tasks.set(node.node.nodeId, latest ?? this.createTask(run, node.node, 1));
    }
    return tasks;
  }

  private createTask(run: Run, node: RunNodeSnapshot, attempt: number): Task {
    const task = this.store.createTask({
      runId: run.id,
      nodeId: node.nodeId,
      label: node.label,
      manifestId: node.manifestId,
      manifestVersion: node.manifestVersion,
      attempt,
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
  ): Promise<TaskOutcome> {
    // A cancellation or rerun may have closed this attempt while the Run was
    // waiting out a retry backoff. Never reopen terminal history.
    if (this.isTerminal(task.id)) return { type: 'stopped' };

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
      // Shutdown monitoring must not cancel executor work; cancellation is an
      // explicit executor.cancel call when a Run is canceled.
      const submitted = await this.executor.submit(spec);
      jobId = submitted.jobId;
      if (this.isTerminal(task.id)) {
        // The attempt was canceled while submission was in flight; the job
        // must stop even though it was not visible to the cancel sweep.
        await this.executor.cancel(jobId).catch(() => undefined);
        return { type: 'stopped' };
      }
      this.store.updateTask(task.id, { jobId });
    } catch (error) {
      if (this.closing) return { type: 'stopped' };
      if (this.isTerminal(task.id)) return { type: 'stopped' };
      return this.failAttempt(run, planned, task, errorMessage(error), 'unknown');
    }

    if (this.closing) return { type: 'stopped' };

    let poll: PollResult;
    try {
      poll = await this.executor.poll(jobId);
      let cancelRequested = false;
      while (!TERMINAL_STATES.has(poll.state)) {
        if (this.closing) return { type: 'stopped' };
        if (signal?.aborted && !cancelRequested) {
          cancelRequested = true;
          await this.executor.cancel(jobId).catch(() => undefined);
        }
        await delay(this.pollIntervalMs);
        if (this.closing) return { type: 'stopped' };
        poll = await this.executor.poll(jobId);
      }
    } catch (error) {
      if (this.closing) return { type: 'stopped' };
      return this.failAttempt(
        run,
        planned,
        task,
        errorMessage(error),
        'unknown',
        jobId,
      );
    }

    if (this.closing) return { type: 'stopped' };
    if (this.isTerminal(task.id)) return { type: 'stopped' };

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
      return this.failAttempt(
        run,
        planned,
        task,
        poll.error ?? 'The Node execution failed.',
        poll.failureKind ?? 'unknown',
        jobId,
        poll.exitCode ?? 1,
      );
    }

    try {
      if (!poll.result) {
        throw new Error(`Executor job "${jobId}" completed without a Task result.`);
      }
      const outputs = this.completeTaskFromResult(
        run,
        task,
        planned,
        jobId,
        poll.result,
        upstreamArtifacts,
        poll.exitCode ?? 0,
      );
      return { type: 'completed', outputs };
    } catch (error) {
      return this.failAttempt(
        run,
        planned,
        task,
        errorMessage(error),
        'unknown',
        jobId,
      );
    }
  }

  /** True when another actor (for example a cancellation) already closed the Task. */
  private isTerminal(taskId: string): boolean {
    const current = this.store.getTask(taskId);
    return !current || TERMINAL_STATES.has(current.state);
  }

  /**
   * Records a completed Task result, its Artifacts and Metrics, and the
   * completion event. Artifact records are idempotent, so adopting a persisted
   * result after a restart is safe.
   */
  private completeTaskFromResult(
    run: Run,
    task: Task,
    planned: PlannedNode,
    jobId: string,
    result: ExecutorTaskResult,
    upstreamArtifacts: string[],
    exitCode = 0,
  ): TaskOutputRecord[] {
    const outputs = this.recordTaskResult(
      run,
      task,
      planned,
      jobId,
      result,
      upstreamArtifacts,
    );
    this.store.saveTaskOutputs(task.id, outputs);
    const completedAt = this.now();
    this.store.updateTask(task.id, {
      state: 'completed',
      exitCode,
      completedAt,
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.completed',
      payload: { exitCode },
      createdAt: completedAt,
    });
    return outputs;
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
        const path = `${this.store.taskNamespacePath(run.id, task.id)}/${artifact.relativePath}`;
        const existing = this.store.findArtifact(task.id, artifact.name);
        if (existing) {
          if (existing.path !== path || existing.sha256 !== artifact.sha256) {
            throw new Error(`Artifact "${artifact.name}" is immutable.`);
          }
          artifactIds.push(existing.id);
          continue;
        }
        const recorded = this.store.recordArtifact({
          runId: run.id,
          taskId: task.id,
          nodeId: node.nodeId,
          name: artifact.name,
          mediaType: artifact.mediaType,
          path,
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
      const existing = this.store.findMetric(task.id, metric.spec.id);
      if (existing) {
        if (
          existing.value !== metric.value ||
          existing.schema.namespace !== metric.schema.namespace ||
          existing.schema.name !== metric.schema.name ||
          existing.schema.version !== metric.schema.version
        ) {
          throw new Error(`Metric "${metric.spec.id}" is immutable.`);
        }
        continue;
      }
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

  /**
   * Records a failed attempt and decides, from the immutable Node Manifest
   * RetryPolicy, whether another attempt may run. Only transient, timeout, and
   * exit-code failures are ever retried; parameter and validation errors end
   * the Run immediately.
   */
  private failAttempt(
    run: Run,
    planned: PlannedNode,
    task: Task,
    message: string,
    failureKind: NodeFailureKind,
    jobId?: string,
    exitCode = 1,
  ): TaskOutcome {
    if (this.isTerminal(task.id)) return { type: 'stopped' };

    const completedAt = this.now();
    this.store.updateTask(task.id, {
      state: 'failed',
      exitCode,
      error: message,
      failureKind,
      ...(jobId ? { jobId } : {}),
      completedAt,
    });
    this.store.appendEvent({
      runId: run.id,
      taskId: task.id,
      type: 'task.failed',
      payload: {
        nodeId: planned.node.nodeId,
        attempt: task.attempt,
        exitCode,
        error: message,
        failureKind,
      },
      createdAt: completedAt,
    });

    const retry = this.scheduleRetry(run, planned.node, task, failureKind, message);
    if (retry) return retry;
    this.markRunFailed(run.id, message, task.id);
    return { type: 'stopped' };
  }

  /**
   * Creates the next Task attempt when the Manifest policy allows it. The
   * failed attempt stays immutable history; the new attempt is visible as
   * queued while the Run waits out the backoff.
   */
  private scheduleRetry(
    run: Run,
    node: RunNodeSnapshot,
    task: Task,
    failureKind: NodeFailureKind,
    message = task.error ?? 'The Task failed.',
  ): Extract<TaskOutcome, { type: 'retry' }> | undefined {
    if (this.closing || this.canceling.has(run.id)) return undefined;
    const currentRun = this.store.getRun(run.id);
    if (!currentRun || TERMINAL_RUN_STATES.has(currentRun.status)) return undefined;
    if (!shouldRetryTask(node.retry, task.attempt, failureKind)) return undefined;

    const retryTask = this.createTask(run, node, task.attempt + 1);
    this.store.appendEvent({
      runId: run.id,
      taskId: retryTask.id,
      type: 'task.retry.scheduled',
      payload: {
        nodeId: node.nodeId,
        attempt: retryTask.attempt,
        previousAttempt: task.attempt,
        failureKind,
        backoffSeconds: node.retry.backoffSeconds,
        error: message,
      },
      createdAt: this.now(),
    });
    return {
      type: 'retry',
      task: retryTask,
      backoffSeconds: node.retry.backoffSeconds,
    };
  }

  /**
   * Cancels a Run: requests every running executor job to stop, closes all
   * non-terminal attempts as canceled history, and records `run.canceled`.
   * Terminal Runs are returned unchanged, so this command is idempotent and
   * can never rewrite completed science.
   */
  async cancelRun(runId: string): Promise<Run> {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError('RUN_NOT_FOUND', `Unknown Run "${runId}".`);
    if (TERMINAL_RUN_STATES.has(run.status)) return run;

    this.canceling.add(runId);
    try {
      this.controllers.get(runId)?.abort();

      const plan = planRun(run.snapshot);
      const tasks = this.ensureTasks(run, plan);
      for (const task of tasks.values()) {
        const current = this.store.getTask(task.id);
        if (!current || TERMINAL_STATES.has(current.state)) continue;

        if (current.state === 'running' && current.jobId) {
          await this.executor.cancel(current.jobId).catch(() => undefined);
        }

        const latest = this.store.getTask(task.id);
        if (!latest || TERMINAL_STATES.has(latest.state)) continue;
        const completedAt = this.now();
        this.store.updateTask(task.id, {
          state: 'canceled',
          exitCode: 130,
          completedAt,
        });
        this.store.appendEvent({
          runId: run.id,
          taskId: task.id,
          type: 'task.canceled',
          payload: {
            nodeId: latest.nodeId,
            attempt: latest.attempt,
            exitCode: 130,
            reason: 'run-canceled',
          },
          createdAt: completedAt,
        });
      }

      this.markRunCanceled(runId);
      return this.store.getRun(runId)!;
    } finally {
      this.canceling.delete(runId);
    }
  }

  /**
   * Explicitly reruns one failed or canceled Task attempt as a new attempt.
   * The original attempt and its logs stay visible; completed upstream work is
   * reused and every other failed/canceled Node is replanned so the Run can
   * reach a terminal state again.
   */
  async rerunTask(runId: string, taskId: string): Promise<{ run: Run; task: Task }> {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError('RUN_NOT_FOUND', `Unknown Run "${runId}".`);
    const task = this.store.getTask(taskId);
    if (!task || task.runId !== runId) {
      throw new OrchestratorError('TASK_NOT_FOUND', `Unknown Task "${taskId}" in Run "${runId}".`);
    }
    if (task.state === 'completed') {
      throw new OrchestratorError(
        'TASK_COMPLETED',
        'A completed Task cannot be rerun; its scientific records are immutable.',
      );
    }
    if (!TERMINAL_STATES.has(task.state)) {
      throw new OrchestratorError('TASK_NOT_TERMINAL', 'Only failed or canceled Tasks can be rerun.');
    }

    const plan = planRun(run.snapshot);
    const latest = new Map<string, Task>();
    for (const candidate of this.store.listTasks(runId)) {
      const existing = latest.get(candidate.nodeId);
      if (!existing || candidate.attempt > existing.attempt) {
        latest.set(candidate.nodeId, candidate);
      }
    }
    if (latest.get(task.nodeId)?.id !== task.id) {
      throw new OrchestratorError(
        'TASK_SUPERSEDED',
        'A newer attempt for this Node already exists; rerun the latest failed attempt.',
      );
    }
    if (run.status === 'queued' || run.status === 'running') {
      throw new OrchestratorError('RUN_ACTIVE', 'Cancel the active Run before rerunning a Task.');
    }
    if (run.status === 'completed') {
      throw new OrchestratorError('RUN_COMPLETED', 'A completed Run cannot be rerun.');
    }

    // Stop any lingering monitor from the previous attempt before replanning.
    this.controllers.get(runId)?.abort();
    await this.whenIdle(runId);

    const created = new Map<string, Task>();
    for (const planned of plan) {
      const nodeId = planned.node.nodeId;
      const current = latest.get(nodeId);
      if (!current) continue;
      if (current.state === 'completed' || current.state === 'queued' || current.state === 'running') {
        continue;
      }
      created.set(nodeId, this.createTask(run, planned.node, current.attempt + 1));
    }

    const rerunTask = created.get(task.nodeId)!;
    this.store.appendEvent({
      runId: run.id,
      taskId: rerunTask.id,
      type: 'run.rerun',
      payload: {
        taskId: task.id,
        nodeId: task.nodeId,
        previousAttempt: task.attempt,
        attempt: rerunTask.attempt,
      },
      createdAt: this.now(),
    });
    this.store.updateRunStatus(runId, 'running');
    this.start(runId);

    return { run: this.store.getRun(runId)!, task: rerunTask };
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
