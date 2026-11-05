import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  NodeImplementation,
  NodeMetricValue,
  NodeRunContext,
} from '@sflow/domain';
import type { CommandInvocation, CommandResult, CommandRunner } from '@sflow/orchestrator';
import { SLURM_TASK_INPUT_FILE } from '@sflow/orchestrator';

/**
 * Slurm scheduler stand-in that executes the Task input written by
 * `SlurmExecutor` and produces ticket #12's `result.json` contract.
 *
 * A real deployment would let the container runtime read `task-input.json`
 * inside the submitted Job. Here the fake `CommandRunner` performs the same
 * steps in-process: it verifies the batch script carries the Manifest's OCI
 * environment, runs the registered Node implementation (or the production
 * package's container entrypoint), writes the output files and `result.json`,
 * and reports deterministic scheduler states.
 */

export interface SimulatedTaskInput {
  version: number;
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  parameters: Record<string, unknown>;
  fileReferences: unknown[];
  inputs: Record<string, unknown>;
  resources: Record<string, unknown>;
}

export interface ContainerEntrypointOptions {
  taskDir: string;
  taskInputPath: string;
  resultPath: string;
  log: (line: string) => void;
}

export type ContainerEntrypoint = (
  options: ContainerEntrypointOptions,
) => Promise<unknown>;

export interface SubmissionRecord {
  jobId: string;
  taskDir: string;
  input: SimulatedTaskInput;
  script: string;
}

interface SimulatedJob {
  id: string;
  state: string;
  exitCode: string;
  taskDir: string;
  outputTemplate: string;
  input: SimulatedTaskInput;
  polls: number;
  executed: boolean;
}

export interface SimulatedSlurmSchedulerOptions {
  projectRoot: string;
  implementations: readonly NodeImplementation[];
  /** Keyed by `manifestId@manifestVersion`; use the production entrypoint. */
  containerEntrypoints?: Record<string, ContainerEntrypoint>;
  submissionFailureFor?: (
    manifestId: string,
    manifestVersion: string,
    script: string,
  ) => string | undefined;
  executionFailureFor?: (
    manifestId: string,
    manifestVersion: string,
    input: SimulatedTaskInput,
  ) => string | undefined;
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
  const index = args.findIndex(
    (value) => value === '-j' || value === '--job' || value === '--jobs',
  );
  return index >= 0 ? args[index + 1] : undefined;
}

function isActive(state: string): boolean {
  return ['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING'].includes(state);
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export class SimulatedSlurmScheduler implements CommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly submissions: SubmissionRecord[] = [];
  readonly jobs = new Map<string, SimulatedJob>();
  submissionFailureFor: SimulatedSlurmSchedulerOptions['submissionFailureFor'];
  executionFailureFor: SimulatedSlurmSchedulerOptions['executionFailureFor'];

  private readonly projectRoot: string;
  private readonly implementations: readonly NodeImplementation[];
  private readonly containerEntrypoints: Record<string, ContainerEntrypoint>;
  private nextId = 7001;

  constructor(options: SimulatedSlurmSchedulerOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.implementations = options.implementations;
    this.containerEntrypoints = options.containerEntrypoints ?? {};
    this.submissionFailureFor = options.submissionFailureFor;
    this.executionFailureFor = options.executionFailureFor;
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    const args = invocation.args;

    if (invocation.command === 'sbatch') {
      return this.submit(args);
    }

    const jobId = jobIdFrom(args);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return ok('');

    if (invocation.command === 'squeue') {
      if (!job.executed) {
        job.polls += 1;
        if (job.polls < 2) {
          job.state = 'RUNNING';
          return ok('RUNNING\n');
        }
        await this.execute(job);
        return ok('');
      }
      if (isActive(job.state)) return ok(`${job.state}\n`);
      return ok('');
    }

    if (invocation.command === 'sacct') {
      if (isActive(job.state)) return ok('');
      return ok(`${job.id}|${job.state}|${job.exitCode}\n${job.id}.batch|${job.state}|${job.exitCode}\n`);
    }

    if (invocation.command === 'scancel') {
      job.state = 'CANCELLED';
      job.exitCode = '0:15';
      return ok('');
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unsupported command ${invocation.command}`,
    };
  }

  private submit(args: string[]): CommandResult {
    const taskDir = argument(args, '--chdir') ?? '';
    const scriptPath = args.find((value) => value.endsWith('.slurm.sh'));
    const outputTemplate = argument(args, '--output') ?? '';
    if (!taskDir || !scriptPath) {
      return { exitCode: 1, stdout: '', stderr: 'sbatch received an invalid Job script.' };
    }

    let input: SimulatedTaskInput;
    try {
      input = JSON.parse(
        readFileSync(join(taskDir, SLURM_TASK_INPUT_FILE), 'utf8'),
      ) as SimulatedTaskInput;
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `sbatch could not read the Task input contract: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const script = readFileSync(scriptPath, 'utf8');
    const failure = this.submissionFailureFor?.(
      input.manifestId,
      input.manifestVersion,
      script,
    );
    if (failure) {
      return { exitCode: 127, stdout: '', stderr: failure };
    }

    const jobId = String(this.nextId++);
    const job: SimulatedJob = {
      id: jobId,
      state: 'PENDING',
      exitCode: '0:0',
      taskDir,
      outputTemplate,
      input,
      polls: 0,
      executed: false,
    };
    this.jobs.set(jobId, job);
    this.submissions.push({ jobId, taskDir, input, script });
    return ok(`${jobId};test-cluster\n`);
  }

  private async execute(job: SimulatedJob): Promise<void> {
    if (job.executed) return;
    job.executed = true;

    const logs = [`slurm_job=${job.id}`];
    const failure = this.executionFailureFor?.(
      job.input.manifestId,
      job.input.manifestVersion,
      job.input,
    );
    if (failure) {
      logs.push('container_state=failed', failure);
      this.writeSchedulerLog(job, logs);
      job.state = 'FAILED';
      job.exitCode = '125:0';
      return;
    }

    try {
      await this.runContainer(job, logs);
      job.state = 'COMPLETED';
      job.exitCode = '0:0';
    } catch (error) {
      logs.push(
        'container_state=failed',
        `container_error=${error instanceof Error ? error.message : String(error)}`,
      );
      job.state = 'FAILED';
      job.exitCode = '1:0';
    }
    this.writeSchedulerLog(job, logs);
  }

  private async runContainer(job: SimulatedJob, logs: string[]): Promise<void> {
    const key = `${job.input.manifestId}@${job.input.manifestVersion}`;
    const entrypoint = this.containerEntrypoints[key];
    if (entrypoint) {
      await entrypoint({
        taskDir: job.taskDir,
        taskInputPath: join(job.taskDir, SLURM_TASK_INPUT_FILE),
        resultPath: join(job.taskDir, 'result.json'),
        log: (line) => logs.push(line),
      });
      return;
    }

    const implementation = this.implementations.find(
      (candidate) =>
        candidate.manifest.id === job.input.manifestId &&
        candidate.manifest.version === job.input.manifestVersion,
    );
    if (!implementation) {
      throw new Error(
        `No simulated container is registered for "${key}".`,
      );
    }

    const context: NodeRunContext = {
      runId: job.input.runId,
      taskId: job.input.taskId,
      nodeId: job.input.nodeId,
      attempt: job.input.attempt,
      outputDir: job.taskDir,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
      writeFile: (relativePath, contents) => this.writeTaskFile(job.taskDir, relativePath, contents),
      readProjectFile: (projectRelativePath) => this.readProjectFile(projectRelativePath),
    };

    const result = await implementation.run(
      job.input.inputs,
      job.input.parameters,
      context,
    );

    const outputs = result.outputs.map((output) => ({
      portId: output.portId,
      ...(output.value !== undefined ? { value: output.value } : {}),
      artifacts: (output.artifacts ?? []).map((artifact) => {
        const absolute = resolve(job.taskDir, artifact.relativePath);
        if (!isInside(resolve(job.taskDir), absolute) || !existsSync(absolute)) {
          throw new Error(
            `Node "${key}" did not write declared Artifact "${artifact.relativePath}".`,
          );
        }
        const bytes = readFileSync(absolute);
        if (statSync(absolute).size !== bytes.byteLength) {
          throw new Error(`Artifact "${artifact.relativePath}" is not stable on disk.`);
        }
        return {
          name: artifact.name,
          relativePath: artifact.relativePath,
          mediaType: artifact.mediaType,
          ...(artifact.schema ? { schema: artifact.schema } : {}),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
        };
      }),
    }));

    const metrics: Array<{
      spec: unknown;
      value: NodeMetricValue;
      schema: { namespace: string; name: string; version: string };
    }> = [];
    for (const [metricId, value] of Object.entries(result.metrics ?? {})) {
      const spec = implementation.manifest.metrics.find(
        (candidate) => candidate.id === metricId,
      );
      if (!spec) {
        throw new Error(`Node "${key}" reported undeclared Metric "${metricId}".`);
      }
      if (typeof value !== spec.valueType) {
        throw new Error(
          `Node "${key}" Metric "${metricId}" must be a ${spec.valueType}.`,
        );
      }
      metrics.push({
        spec,
        value,
        schema: {
          namespace: `sflow.binder.${implementation.manifest.id}`,
          name: metricId,
          version: implementation.manifest.version,
        },
      });
    }

    writeFileSync(
      join(job.taskDir, 'result.json'),
      `${JSON.stringify({ outputs, metrics }, null, 2)}\n`,
    );
  }

  private writeTaskFile(
    taskDir: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): string {
    if (isAbsolute(relativePath)) {
      throw new Error('Task outputs must be relative to the Task namespace.');
    }
    const root = resolve(taskDir);
    const absolute = resolve(root, relativePath);
    if (!isInside(root, absolute)) {
      throw new Error('Task outputs must stay inside the Task namespace.');
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, { flag: 'wx' });
    return absolute;
  }

  private readProjectFile(projectRelativePath: string): string | undefined {
    try {
      const absolute = resolve(this.projectRoot, projectRelativePath);
      if (!isInside(this.projectRoot, absolute)) return undefined;
      return readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
  }

  private writeSchedulerLog(job: SimulatedJob, lines: readonly string[]): void {
    mkdirSync(job.taskDir, { recursive: true });
    writeFileSync(
      job.outputTemplate.replace('%j', job.id).replace('%A', job.id),
      `${lines.join('\n')}\n`,
    );
  }
}
