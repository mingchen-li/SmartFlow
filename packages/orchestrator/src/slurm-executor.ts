import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  NodeFailureKind,
  NodeResources,
  TaskState,
} from '@sflow/domain';
import type {
  ComputeExecutor,
  ExecutorTaskResult,
  PollResult,
  ReconcileJob,
  ReconcileResult,
  SubmitOptions,
  SubmitResult,
  TaskSpec,
} from './contracts';
import type { CommandRunner } from './command-runner';

export interface SlurmExecutorOptions {
  /** Absolute directory for persisted executor job state. */
  jobsDir: string;
  /** Injected scheduler command seam; tests use a fake implementation. */
  runner: CommandRunner;
  clock?: () => Date;
  /** Additional `sbatch` options, for example `['--partition=gpu']`. */
  sbatchArgs?: string[];
  /** OCI-compatible container runtime used inside the Slurm Job. */
  containerRuntime?: string;
  /** Arguments inserted before the image, default `exec --containall`. */
  containerRuntimeArgs?: string[];
}

interface PersistedSlurmJob {
  executor: 'slurm';
  jobId: string;
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  taskDir: string;
  logsPath: string;
  schedulerLogPath: string;
  scriptPath: string;
  state: TaskState;
  /** Raw scheduler state, retained only for diagnostics. */
  schedulerState?: string;
  exitCode?: number;
  error?: string;
  failureKind?: NodeFailureKind;
  cancelRequested: boolean;
  result?: ExecutorTaskResult;
  createdAt: string;
  updatedAt: string;
}

const TERMINAL_STATES = new Set<TaskState>(['completed', 'failed', 'canceled']);

/**
 * Task input contract handed to the container running inside the Slurm Job.
 *
 * The batch script and container share the Task namespace as their working
 * directory. Persisting the resolved parameters, inline inputs, and File
 * References here keeps container execution independent of the Server process
 * and makes the exact execution contract inspectable next to its outputs.
 */
export const SLURM_TASK_INPUT_FILE = 'task-input.json';
export const SLURM_TASK_INPUT_VERSION = 1;

interface PersistedTaskInput {
  version: typeof SLURM_TASK_INPUT_VERSION;
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  parameters: Record<string, unknown>;
  fileReferences: TaskSpec['fileReferences'];
  inputs: Record<string, unknown>;
  resources: TaskSpec['resources'];
}

function taskInputFor(spec: TaskSpec): PersistedTaskInput {
  return {
    version: SLURM_TASK_INPUT_VERSION,
    runId: spec.runId,
    taskId: spec.taskId,
    nodeId: spec.nodeId,
    attempt: spec.attempt,
    manifestId: spec.manifestId,
    manifestVersion: spec.manifestVersion,
    parameters: spec.parameters,
    fileReferences: spec.fileReferences,
    inputs: spec.inputs,
    resources: spec.resources,
  };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function jobName(value: string): string {
  return `sflow-${value.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
}

/** Converts a Manifest memory declaration into Slurm's megabyte form. */
export function slurmMemory(memory: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?)\s?(Ki|Mi|Gi|Ti|K|M|G|T|B|KB|MB|GB|TB)$/i.exec(memory);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const megabytes =
    unit === 'ki'
      ? value / 1024
      : unit === 'mi'
        ? value
        : unit === 'gi'
          ? value * 1024
          : unit === 'ti'
            ? value * 1024 * 1024
            : unit === 'k' || unit === 'kb'
              ? value / 1000
              : unit === 'm' || unit === 'mb'
                ? value
                : unit === 'g' || unit === 'gb'
                  ? value * 1000
                  : unit === 't' || unit === 'tb'
                    ? value * 1000 * 1000
                    : value / 1_000_000;
  return `${Math.max(1, Math.ceil(megabytes))}M`;
}

function resourceArgs(resources: NodeResources): string[] {
  const args: string[] = [];
  if (resources.cpu !== undefined) args.push(`--cpus-per-task=${resources.cpu}`);
  if (resources.memory !== undefined) {
    const memory = slurmMemory(resources.memory);
    if (memory) args.push(`--mem=${memory}`);
  }
  if (resources.walltimeMinutes !== undefined) {
    args.push(`--time=${resources.walltimeMinutes}`);
  }
  if (resources.gpu !== undefined && resources.gpu > 0) {
    args.push(`--gres=gpu:${resources.gpu}`);
  }
  if (resources.gpuType !== undefined) {
    args.push(`--constraint=${resources.gpuType}`);
  }
  return args;
}

/** Builds the batch script that runs exactly one atomic Node attempt. */
export function buildSlurmScript(
  spec: TaskSpec,
  options: {
    containerRuntime: string;
    containerRuntimeArgs: string[];
  },
): string {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export SFLOW_RUN_ID=${quote(spec.runId)}`,
    `export SFLOW_TASK_ID=${quote(spec.taskId)}`,
    `export SFLOW_NODE_ID=${quote(spec.nodeId)}`,
    `export SFLOW_ATTEMPT=${quote(String(spec.attempt))}`,
    `export SFLOW_MANIFEST_ID=${quote(spec.manifestId)}`,
    `export SFLOW_MANIFEST_VERSION=${quote(spec.manifestVersion)}`,
    `export SFLOW_TASK_DIR=${quote(spec.taskDir)}`,
  ];
  for (const [name, value] of Object.entries(spec.environment.variables ?? {})) {
    lines.push(`export ${name}=${quote(value)}`);
  }
  lines.push(`cd ${quote(spec.taskDir)}`);

  const command = spec.environment.command ?? [];
  if (spec.environment.kind === 'container') {
    const invocation = [
      options.containerRuntime,
      ...options.containerRuntimeArgs,
      quote(spec.environment.image),
      ...command.map(quote),
    ];
    lines.push(`exec ${invocation.join(' ')}`);
  } else {
    // Host environments are a development escape hatch, not the production
    // path: they must declare the exact process to run.
    if (command.length === 0) {
      throw new Error(
        `Host environment for Node "${spec.nodeId}" must declare a command; production Nodes use containers.`,
      );
    }
    lines.push(`exec ${command.map(quote).join(' ')}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Deterministic scheduler-state mapping. Raw Slurm vocabulary is never a Task
 * state; failures carry the Node failure kind used by the Manifest RetryPolicy.
 */
export function mapSlurmState(raw: string): {
  state: TaskState;
  failureKind?: NodeFailureKind;
} {
  switch (normalizeState(raw)) {
    case 'PENDING':
    case 'CONFIGURING':
    case 'REQUEUED':
    case 'RESIZING':
      return { state: 'queued' };
    case 'RUNNING':
    case 'COMPLETING':
    case 'STAGE_OUT':
    case 'SUSPENDED':
      return { state: 'running' };
    case 'COMPLETED':
      return { state: 'completed' };
    case 'FAILED':
      return { state: 'failed', failureKind: 'exit-code' };
    case 'NODE_FAIL':
    case 'BOOT_FAIL':
    case 'OUT_OF_MEMORY':
    case 'PREEMPTED':
    case 'REVOKED':
      return { state: 'failed', failureKind: 'transient' };
    case 'TIMEOUT':
    case 'DEADLINE':
      return { state: 'failed', failureKind: 'timeout' };
    case 'CANCELLED':
      return { state: 'canceled' };
    default:
      return { state: 'failed', failureKind: 'unknown' };
  }
}

function normalizeState(raw: string): string {
  return raw.trim().toUpperCase().split(/\s+/)[0].replace(/\+$/, '');
}

function parseExitCode(value: string): number | undefined {
  const parsed = Number.parseInt(value.split(':')[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readLogLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  if (contents.length === 0) return [];
  return contents.replace(/\n$/, '').split('\n');
}

/**
 * Reads the Node result contract a completed Job writes next to its outputs.
 * A missing file leaves the Task completed without a result; malformed content
 * is a validation failure because the Node violated its output contract.
 */
function readTaskResult(
  taskDir: string,
  logsPath: string,
): ExecutorTaskResult | undefined {
  const resultPath = join(taskDir, 'result.json');
  if (!existsSync(resultPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    throw new Error(`Slurm Job wrote an unreadable result.json at "${resultPath}".`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { outputs?: unknown }).outputs) ||
    !Array.isArray((parsed as { metrics?: unknown }).metrics)
  ) {
    throw new Error(
      `Slurm Job result.json at "${resultPath}" must declare outputs and metrics arrays.`,
    );
  }

  return {
    outputs: (parsed as ExecutorTaskResult).outputs,
    metrics: (parsed as ExecutorTaskResult).metrics,
    logsPath,
  };
}

export function parseSchedulerJobId(stdout: string): string {
  const line = stdout
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) {
    throw new Error('sbatch did not report a Slurm Job id.');
  }
  const jobId = line.split(';')[0].trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) {
    throw new Error(`sbatch reported an invalid Slurm Job id "${line}".`);
  }
  return jobId;
}

/**
 * Slurm Compute Executor.
 *
 * One atomic Node attempt maps to one Slurm Job. Submission, polling, log
 * collection, cancellation, and restart reconciliation all run through the
 * injected `CommandRunner`, so SFlow's Task vocabulary never exposes raw
 * scheduler states.
 */
export class SlurmExecutor implements ComputeExecutor {
  readonly kind = 'slurm' as const;
  private readonly jobsDir: string;
  private readonly runner: CommandRunner;
  private readonly clock: () => Date;
  private readonly sbatchArgs: string[];
  private readonly containerRuntime: string;
  private readonly containerRuntimeArgs: string[];

  constructor(options: SlurmExecutorOptions) {
    this.jobsDir = resolve(options.jobsDir);
    this.runner = options.runner;
    this.clock = options.clock ?? (() => new Date());
    this.sbatchArgs = options.sbatchArgs ?? [];
    this.containerRuntime = options.containerRuntime ?? 'apptainer';
    this.containerRuntimeArgs = options.containerRuntimeArgs ?? ['exec', '--containall'];
    mkdirSync(this.jobsDir, { recursive: true });
  }

  async submit(spec: TaskSpec, _options: SubmitOptions = {}): Promise<SubmitResult> {
    const taskDir = resolve(spec.taskDir);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, SLURM_TASK_INPUT_FILE),
      `${JSON.stringify(taskInputFor(spec), null, 2)}\n`,
    );

    const scriptPath = join(taskDir, `.sflow-${spec.taskId}-attempt-${spec.attempt}.slurm.sh`);
    writeFileSync(
      scriptPath,
      buildSlurmScript(spec, {
        containerRuntime: this.containerRuntime,
        containerRuntimeArgs: this.containerRuntimeArgs,
      }),
    );

    const args = [
      '--parsable',
      `--job-name=${jobName(spec.taskId)}`,
      '--nodes=1',
      '--ntasks=1',
      `--chdir=${taskDir}`,
      `--output=${join(taskDir, 'slurm-%j.out')}`,
      ...resourceArgs(spec.resources),
      ...this.sbatchArgs,
      scriptPath,
    ];

    const command = await this.runner.run({ command: 'sbatch', args });
    if (command.exitCode !== 0) {
      throw new Error(
        `sbatch failed for Task "${spec.taskId}" (exit code ${command.exitCode}): ${
          command.stderr.trim() || command.stdout.trim() || 'no scheduler output'
        }`,
      );
    }
    const jobId = parseSchedulerJobId(command.stdout);

    const now = this.clock().toISOString();
    const job: PersistedSlurmJob = {
      executor: 'slurm',
      jobId,
      runId: spec.runId,
      taskId: spec.taskId,
      nodeId: spec.nodeId,
      attempt: spec.attempt,
      manifestId: spec.manifestId,
      manifestVersion: spec.manifestVersion,
      taskDir,
      logsPath: join(taskDir, 'logs.txt'),
      schedulerLogPath: join(taskDir, `slurm-${jobId}.out`),
      scriptPath,
      state: 'queued',
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.persist(job);
    return { jobId };
  }

  async poll(jobId: string): Promise<PollResult> {
    const job = this.load(jobId);
    if (!job) throw new Error(`Executor job "${jobId}" was not found.`);
    if (!TERMINAL_STATES.has(job.state)) {
      await this.refresh(job);
    }
    return this.snapshot(job);
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.load(jobId);
    if (!job) throw new Error(`Executor job "${jobId}" was not found.`);
    if (TERMINAL_STATES.has(job.state)) return;

    // Record the intent before invoking the scheduler so restart recovery sees
    // that SFlow asked for cancellation even if the process stops mid-command.
    job.cancelRequested = true;
    this.touch(job);

    const canceled = await this.runner.run({ command: 'scancel', args: [jobId] });
    if (canceled.exitCode !== 0) {
      throw new Error(
        `scancel failed for Slurm Job "${jobId}" (exit code ${canceled.exitCode}): ${
          canceled.stderr.trim() || canceled.stdout.trim() || 'no scheduler output'
        }`,
      );
    }

    job.state = 'canceled';
    job.exitCode = 130;
    delete job.error;
    delete job.failureKind;
    this.collectLogs(job);
    this.touch(job);
  }

  /**
   * Rebuilds one Run's executor view from persisted Job records. Non-terminal
   * Jobs are refreshed from the scheduler, so Jobs submitted by a previous
   * Server process are reconnected rather than resubmitted. Terminal records
   * are returned as-is, which keeps completed science idempotent.
   */
  async reconcile(runId: string): Promise<ReconcileResult> {
    mkdirSync(this.jobsDir, { recursive: true });
    const jobs: ReconcileJob[] = [];
    for (const entry of readdirSync(this.jobsDir)) {
      if (!entry.endsWith('.json')) continue;
      const job = this.read(join(this.jobsDir, entry));
      if (!job || job.runId !== runId) continue;

      if (!TERMINAL_STATES.has(job.state)) {
        try {
          await this.refresh(job);
        } catch {
          // The scheduler is unreachable right now; keep the persisted truth
          // so a later reconcile can reconnect instead of losing the Job.
        }
      }

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

  /**
   * Queries the scheduler for the Job's raw state and folds it into the
   * persisted Task-facing record. SFlow Task states never carry raw Slurm
   * vocabulary; the raw state is retained for diagnostics only.
   */
  private async refresh(job: PersistedSlurmJob): Promise<void> {
    const scheduler = await this.queryScheduler(job.jobId);
    if (!scheduler) {
      this.fail(job, `Slurm Job ${job.jobId} is no longer reported by the scheduler.`, 'unknown');
      return;
    }

    job.schedulerState = scheduler.state;
    const mapped = mapSlurmState(scheduler.state);

    if (mapped.state === 'queued' || mapped.state === 'running') {
      job.state = mapped.state;
      this.collectLogs(job);
      this.touch(job);
      return;
    }

    if (mapped.state === 'canceled') {
      job.state = 'canceled';
      job.exitCode = 130;
      delete job.error;
      delete job.failureKind;
      this.collectLogs(job);
      this.touch(job);
      return;
    }

    if (mapped.state === 'failed') {
      const exitCode = scheduler.exitCode ?? 1;
      this.collectLogs(job);
      this.fail(
        job,
        `Slurm Job ${job.jobId} failed with scheduler state "${scheduler.state}" (exit code ${exitCode}).`,
        mapped.failureKind ?? 'unknown',
        exitCode,
      );
      return;
    }

    const exitCode = scheduler.exitCode ?? 0;
    if (exitCode !== 0) {
      this.collectLogs(job);
      this.fail(
        job,
        `Slurm Job ${job.jobId} reported COMPLETED with exit code ${exitCode}.`,
        'exit-code',
        exitCode,
      );
      return;
    }

    this.collectLogs(job);
    try {
      job.result = readTaskResult(job.taskDir, job.logsPath);
      job.state = 'completed';
      job.exitCode = 0;
      delete job.error;
      delete job.failureKind;
    } catch (error) {
      this.fail(
        job,
        error instanceof Error ? error.message : 'The Slurm Job result was invalid.',
        'validation',
        1,
      );
      return;
    }
    this.touch(job);
  }

  /**
   * Reads the raw scheduler state. `squeue` covers queued and running Jobs;
   * `sacct` supplies terminal states and exit codes once a Job leaves the
   * queue. Returns undefined when neither source knows the Job.
   */
  private async queryScheduler(
    jobId: string,
  ): Promise<{ state: string; exitCode?: number } | undefined> {
    const queue = await this.runner.run({
      command: 'squeue',
      args: ['--noheader', '--format=%T', `--job=${jobId}`],
    });
    if (queue.exitCode === 0) {
      const raw = queue.stdout.trim().split(/\s+/)[0];
      if (raw) return { state: normalizeState(raw) };
    }

    const accounting = await this.runner.run({
      command: 'sacct',
      args: [
        '--noheader',
        '--parsable2',
        '--format=JobID,State,ExitCode',
        `--jobs=${jobId}`,
      ],
    });
    if (accounting.exitCode !== 0) {
      throw new Error(
        `Could not query Slurm Job "${jobId}": ${
          accounting.stderr.trim() || 'sacct failed'
        }`,
      );
    }

    const rows = accounting.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split('|'));
    const row = rows.find((parts) => parts[0] === jobId) ?? rows[0];
    if (!row || !row[1]) return undefined;

    return {
      state: normalizeState(row[1]),
      ...(row[2] !== undefined ? { exitCode: parseExitCode(row[2]) } : {}),
    };
  }

  /** Copies the scheduler stdout file into the Task's line-oriented log file. */
  private collectLogs(job: PersistedSlurmJob): void {
    if (!existsSync(job.schedulerLogPath)) return;
    mkdirSync(job.taskDir, { recursive: true });
    writeFileSync(job.logsPath, readFileSync(job.schedulerLogPath, 'utf8'));
  }

  private fail(
    job: PersistedSlurmJob,
    message: string,
    failureKind: NodeFailureKind,
    exitCode = 1,
  ): void {
    job.state = 'failed';
    job.exitCode = exitCode;
    job.error = message;
    job.failureKind = failureKind;
    this.touch(job);
  }

  private touch(job: PersistedSlurmJob): void {
    job.updatedAt = this.clock().toISOString();
    this.persist(job);
  }

  private snapshot(job: PersistedSlurmJob): PollResult {
    const logs = readLogLines(job.logsPath);
    return {
      state: job.state,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.failureKind !== undefined ? { failureKind: job.failureKind } : {}),
      logs,
      ...(job.result ? { result: job.result } : {}),
    };
  }

  private persist(job: PersistedSlurmJob): void {
    mkdirSync(this.jobsDir, { recursive: true });
    const path = join(this.jobsDir, `${job.jobId}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
    renameSync(temporary, path);
  }

  private load(jobId: string): PersistedSlurmJob | undefined {
    return this.read(join(this.jobsDir, `${jobId}.json`));
  }

  private read(path: string): PersistedSlurmJob | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedSlurmJob;
      return parsed.executor === 'slurm' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
