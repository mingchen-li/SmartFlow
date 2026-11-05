import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  NodeExecutionError,
  type NodeFailureKind,
  type NodeImplementation,
  type NodeMetricValue,
  type NodeRegistry,
  type NodeRunContext,
  type NodeRunResult,
} from '@sflow/domain';
import type {
  ComputeExecutor,
  ExecutorArtifactFile,
  ExecutorMetric,
  ExecutorOutput,
  ExecutorTaskResult,
  PollResult,
  ReconcileResult,
  SubmitOptions,
  SubmitResult,
  TaskSpec,
} from './contracts';

export interface LocalExecutorOptions {
  /** Project root; path-backed inputs are read from here and never escaped. */
  projectRoot: string;
  /** Absolute directory for persisted executor job state. */
  jobsDir: string;
  registry: NodeRegistry;
  clock?: () => Date;
  /**
   * Deterministic pause before a Node starts. Integration tests use this to
   * observe an active Run mid-execution; it defaults to no delay.
   */
  executionDelayMs?: number;
}

interface PersistedJob {
  /** Discriminator so Local and Slurm executors never adopt each other's jobs. */
  executor?: 'local';
  jobId: string;
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  state: PollResult['state'];
  exitCode?: number;
  error?: string;
  failureKind?: NodeFailureKind;
  logsPath: string;
  createdAt: string;
  updatedAt: string;
  result?: ExecutorTaskResult;
}

interface JobHandle {
  job: PersistedJob;
  controller: AbortController;
}

const TERMINAL_STATES = new Set<PollResult['state']>(['completed', 'failed', 'canceled']);

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function readLogLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  if (contents.length === 0) return [];
  return contents.replace(/\n$/, '').split('\n');
}

/**
 * Deterministic in-process Compute Executor.
 *
 * Each submit creates one executor job and one persisted job record. The Node
 * runs against the Task namespace, writes line-oriented logs and immutable
 * outputs, and the executor computes each output Artifact's SHA-256 and size.
 * `reconcile` reads persisted jobs so a later Server restart can rebuild Run
 * state without scheduler access.
 */
export class LocalExecutor implements ComputeExecutor {
  readonly kind = 'local' as const;
  private readonly projectRoot: string;
  private readonly jobsDir: string;
  private readonly registry: NodeRegistry;
  private readonly clock: () => Date;
  private readonly executionDelayMs: number;
  private readonly jobs = new Map<string, JobHandle>();

  constructor(options: LocalExecutorOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.jobsDir = resolve(options.jobsDir);
    this.registry = options.registry;
    this.clock = options.clock ?? (() => new Date());
    this.executionDelayMs = Math.max(0, options.executionDelayMs ?? 0);
    mkdirSync(this.jobsDir, { recursive: true });
  }

  async submit(spec: TaskSpec, options: SubmitOptions = {}): Promise<SubmitResult> {
    const implementation = this.registry.get(spec.manifestId, spec.manifestVersion);
    if (!implementation) {
      throw new Error(
        `No Node implementation is registered for "${spec.manifestId}@${spec.manifestVersion}".`,
      );
    }

    const jobId = `job-${randomUUID()}`;
    const now = this.clock().toISOString();
    const taskDir = resolve(spec.taskDir);
    mkdirSync(taskDir, { recursive: true });
    const logsPath = join(taskDir, 'logs.txt');

    const job: PersistedJob = {
      executor: 'local',
      jobId,
      runId: spec.runId,
      taskId: spec.taskId,
      nodeId: spec.nodeId,
      attempt: spec.attempt,
      manifestId: spec.manifestId,
      manifestVersion: spec.manifestVersion,
      state: 'queued',
      logsPath,
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();
    const handle: JobHandle = { job, controller };
    this.jobs.set(jobId, handle);
    this.persist(job);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    void this.execute(spec, implementation, handle);
    return { jobId };
  }

  async poll(jobId: string): Promise<PollResult> {
    const job = this.jobs.get(jobId)?.job ?? this.load(jobId);
    if (!job) throw new Error(`Executor job "${jobId}" was not found.`);

    return this.snapshot(job);
  }

  async cancel(jobId: string): Promise<void> {
    const handle = this.jobs.get(jobId);
    if (handle) {
      handle.controller.abort();
      return;
    }

    const persisted = this.load(jobId);
    if (!persisted) throw new Error(`Executor job "${jobId}" was not found.`);
    if (TERMINAL_STATES.has(persisted.state)) return;

    const canceled: PersistedJob = {
      ...persisted,
      state: 'canceled',
      exitCode: 130,
      updatedAt: this.clock().toISOString(),
    };
    this.persist(canceled);
  }

  async reconcile(runId: string): Promise<ReconcileResult> {
    mkdirSync(this.jobsDir, { recursive: true });
    const jobs: ReconcileResult['jobs'] = [];
    for (const entry of readdirSync(this.jobsDir)) {
      if (!entry.endsWith('.json')) continue;
      const job = this.read(join(this.jobsDir, entry));
      if (!job || job.runId !== runId) continue;
      jobs.push({
        jobId: job.jobId,
        runId: job.runId,
        taskId: job.taskId,
        nodeId: job.nodeId,
        attempt: job.attempt,
        state: job.state,
        ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
        ...(job.error !== undefined ? { error: job.error } : {}),
        ...(job.failureKind !== undefined ? { failureKind: job.failureKind } : {}),
      });
    }

    jobs.sort((left, right) => left.jobId.localeCompare(right.jobId));
    return { jobs };
  }

  private async execute(
    spec: TaskSpec,
    implementation: NodeImplementation,
    handle: JobHandle,
  ): Promise<void> {
    const { job, controller } = handle;
    const signal = controller.signal;
    const log = (line: string): void => this.appendLog(job.logsPath, line);

    try {
      if (signal.aborted) {
        this.finish(job, { state: 'canceled', exitCode: 130 }, log);
        return;
      }

      this.updateJob(job, { state: 'running' });
      log(`node=${implementation.manifest.id} attempt=${spec.attempt}`);
      log('state=running');

      if (!(await this.pause(this.executionDelayMs, signal))) {
        this.finish(job, { state: 'canceled', exitCode: 130 }, log);
        return;
      }

      const context: NodeRunContext = {
        runId: spec.runId,
        taskId: spec.taskId,
        nodeId: spec.nodeId,
        attempt: spec.attempt,
        outputDir: resolve(spec.taskDir),
        signal,
        log,
        writeFile: (relativePath, contents) =>
          this.writeTaskFile(spec.taskDir, relativePath, contents),
        readProjectFile: (projectRelativePath) =>
          this.readProjectFile(projectRelativePath),
      };

      const result = implementation.run(spec.inputs, spec.parameters, context);
      const resolved = await result;
      if (signal.aborted) {
        this.finish(job, { state: 'canceled', exitCode: 130 }, log);
        return;
      }

      const executorResult = this.resolveResult(spec, implementation, resolved, log);
      this.finish(
        job,
        { state: 'completed', exitCode: 0, result: executorResult },
        log,
      );
    } catch (error) {
      if (signal.aborted) {
        this.finish(job, { state: 'canceled', exitCode: 130 }, log);
        return;
      }
      const message = error instanceof Error ? error.message : 'The Node execution failed.';
      // A Node may classify its own failure. An unclassified throw is a
      // non-zero process exit; parameter and validation errors are declared
      // explicitly and are never eligible for Manifest retry.
      const failureKind: NodeFailureKind =
        error instanceof NodeExecutionError ? error.failureKind : 'exit-code';
      log(`error=${message}`);
      this.finish(job, { state: 'failed', exitCode: 1, error: message, failureKind }, log);
    }
  }

  private resolveResult(
    spec: TaskSpec,
    implementation: NodeImplementation,
    result: NodeRunResult,
    log: (line: string) => void,
  ): ExecutorTaskResult {
    const declaredPorts = new Set(implementation.manifest.outputs.map((port) => port.id));
    const declaredMetrics = new Map(
      implementation.manifest.metrics.map((metric) => [metric.id, metric]),
    );

    const outputs: ExecutorOutput[] = result.outputs.map((output) => {
      if (!declaredPorts.has(output.portId)) {
        throw new NodeExecutionError(
          'validation',
          `Node "${implementation.manifest.id}" produced undeclared output port "${output.portId}".`,
        );
      }

      const artifacts = (output.artifacts ?? []).map((artifact) =>
        this.inspectArtifact(spec.taskDir, artifact, log),
      );
      return {
        portId: output.portId,
        ...(output.value !== undefined ? { value: output.value } : {}),
        artifacts,
      };
    });

    const metrics: ExecutorMetric[] = [];
    for (const [metricId, value] of Object.entries(result.metrics ?? {})) {
      const metricSpec = declaredMetrics.get(metricId);
      if (!metricSpec) {
        throw new NodeExecutionError(
          'validation',
          `Node "${implementation.manifest.id}" produced undeclared Metric "${metricId}".`,
        );
      }
      if (typeof value !== metricSpec.valueType) {
        throw new NodeExecutionError(
          'validation',
          `Metric "${metricId}" must be a ${metricSpec.valueType}, received ${typeof value}.`,
        );
      }
      metrics.push({
        spec: metricSpec,
        value: value as NodeMetricValue,
        schema: {
          namespace: `sflow.binder.${implementation.manifest.id}`,
          name: metricId,
          version: implementation.manifest.version,
        },
      });
    }

    return {
      outputs,
      metrics,
      logsPath: join(resolve(spec.taskDir), 'logs.txt'),
    };
  }

  private inspectArtifact(
    taskDir: string,
    artifact: {
      name: string;
      relativePath: string;
      mediaType: string;
      schema?: ExecutorArtifactFile['schema'];
    },
    log: (line: string) => void,
  ): ExecutorArtifactFile {
    if (!artifact.name || !artifact.mediaType) {
      throw new NodeExecutionError(
        'validation',
        'Artifact declarations require a name and media type.',
      );
    }
    if (isAbsolute(artifact.relativePath)) {
      throw new NodeExecutionError(
        'validation',
        `Artifact "${artifact.name}" must stay inside the Task namespace.`,
      );
    }

    const absolute = resolve(taskDir, artifact.relativePath);
    if (!isInside(resolve(taskDir), absolute)) {
      throw new NodeExecutionError(
        'validation',
        `Artifact "${artifact.name}" must stay inside the Task namespace.`,
      );
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new NodeExecutionError(
        'validation',
        `Artifact "${artifact.name}" was not written to "${artifact.relativePath}".`,
      );
    }

    const bytes = readFileSync(absolute);
    log(`wrote ${artifact.relativePath}`);
    return {
      name: artifact.name,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType,
      ...(artifact.schema ? { schema: artifact.schema } : {}),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    };
  }

  private writeTaskFile(
    taskDir: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): string {
    if (isAbsolute(relativePath)) {
      throw new NodeExecutionError(
        'validation',
        'Task outputs must use a path relative to the Task namespace.',
      );
    }
    const root = resolve(taskDir);
    const absolute = resolve(root, relativePath);
    if (!isInside(root, absolute)) {
      throw new NodeExecutionError('validation', 'Task outputs must stay inside the Task namespace.');
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, { flag: 'wx' });
    return absolute;
  }

  private readProjectFile(projectRelativePath: string): string | undefined {
    if (isAbsolute(projectRelativePath)) return undefined;
    const absolute = resolve(this.projectRoot, projectRelativePath);
    if (!isInside(this.projectRoot, absolute)) return undefined;
    try {
      if (!statSync(absolute).isFile()) return undefined;
      return readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
  }

  private finish(
    job: PersistedJob,
    patch: Pick<PersistedJob, 'state' | 'exitCode'> & {
      error?: string;
      failureKind?: NodeFailureKind;
      result?: ExecutorTaskResult;
    },
    log: (line: string) => void,
  ): void {
    this.updateJob(job, patch);
    log(`state=${patch.state}`);
  }

  private updateJob(job: PersistedJob, patch: Partial<PersistedJob>): void {
    Object.assign(job, patch, { updatedAt: this.clock().toISOString() });
    this.persist(job);
  }

  /** Abortable pause; resolves false when the signal aborts before the delay ends. */
  private pause(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    if (milliseconds <= 0) return Promise.resolve(!signal.aborted);
    if (signal.aborted) return Promise.resolve(false);

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

  private appendLog(path: string, line: string): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  }

  private snapshot(job: PersistedJob): PollResult {
    return {
      state: job.state,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.failureKind !== undefined ? { failureKind: job.failureKind } : {}),
      logs: readLogLines(job.logsPath),
      ...(job.result ? { result: job.result } : {}),
    };
  }

  private persist(job: PersistedJob): void {
    mkdirSync(this.jobsDir, { recursive: true });
    const path = join(this.jobsDir, `${job.jobId}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
    renameSync(temporary, path);
  }

  private load(jobId: string): PersistedJob | undefined {
    return this.read(join(this.jobsDir, `${jobId}.json`));
  }

  private read(path: string): PersistedJob | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedJob;
      // Records written before the discriminator existed are local jobs. Slurm
      // records in a shared jobs directory must never be adopted here.
      return parsed.executor === undefined || parsed.executor === 'local' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
