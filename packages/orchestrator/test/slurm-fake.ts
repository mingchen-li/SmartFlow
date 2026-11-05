import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from '@sflow/orchestrator';

export interface FakeJob {
  id: string;
  /** 1-based submission order, used by test-controlled terminal states. */
  sequence: number;
  state: string;
  exitCode: string;
  taskDir: string;
  outputTemplate: string;
  /** When set, squeue advances the job towards completion automatically. */
  pollsToComplete?: number;
}

export interface FakeCommandRunnerOptions {
  /** Complete each new Job after this many squeue polls. */
  autoCompletePolls?: number;
  /** Terminal state and exit code for the Nth submitted Job (1-based). */
  terminalStateFor?: (sequence: number) => { state: string; exitCode?: string };
  /** Observe each submission, for example to keep one Job running. */
  onSubmit?: (job: FakeJob, sequence: number) => void;
}

/**
 * In-memory Slurm stand-in. It records every scheduler invocation and lets a
 * test control each Job's raw state, so no real Slurm, network, or container is
 * involved.
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly jobs = new Map<string, FakeJob>();
  private nextId = 1001;
  private submitted = 0;

  constructor(private readonly options: FakeCommandRunnerOptions = {}) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    const args = invocation.args;

    if (invocation.command === 'sbatch') {
      const id = String(this.nextId++);
      const sequence = ++this.submitted;
      const job: FakeJob = {
        id,
        sequence,
        state: 'PENDING',
        exitCode: '0:0',
        taskDir: argument(args, '--chdir') ?? '',
        outputTemplate: argument(args, '--output') ?? '',
        ...(this.options.autoCompletePolls !== undefined
          ? { pollsToComplete: this.options.autoCompletePolls }
          : {}),
      };
      this.jobs.set(id, job);
      this.options.onSubmit?.(job, sequence);
      return ok(`${id};test-cluster\n`);
    }

    const jobId = jobIdFrom(args);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job) return ok('');

    if (invocation.command === 'squeue') {
      if (job.pollsToComplete !== undefined) {
        job.pollsToComplete -= 1;
        if (job.pollsToComplete > 0) {
          job.state = 'RUNNING';
          return ok('RUNNING\n');
        }
        const terminal = this.options.terminalStateFor?.(job.sequence) ?? {
          state: 'COMPLETED',
        };
        job.state = terminal.state;
        job.exitCode = terminal.exitCode ?? '0:0';
        if (job.state === 'COMPLETED') this.writeCompletionArtifacts(job);
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

    return { exitCode: 1, stdout: '', stderr: `Unsupported command ${invocation.command}` };
  }

  /** Sets one Job's raw scheduler state; terminal states are read via sacct. */
  setState(jobId: string, state: string, exitCode = '0:0'): void {
    const job = this.jobs.get(jobId)!;
    job.state = state;
    job.exitCode = exitCode;
  }

  /** Writes the scheduler stdout file for a Job. */
  writeJobLog(jobId: string, contents: string): void {
    const job = this.jobs.get(jobId)!;
    mkdirSync(job.taskDir, { recursive: true });
    writeFileSync(schedulerLogPath(job), contents);
  }

  /** Writes the Node result contract consumed by the executor. */
  writeResult(jobId: string, result: unknown): void {
    writeFileSync(join(this.jobs.get(jobId)!.taskDir, 'result.json'), JSON.stringify(result));
  }

  private writeCompletionArtifacts(job: FakeJob): void {
    mkdirSync(job.taskDir, { recursive: true });
    try {
      readFileSync(schedulerLogPath(job));
    } catch {
      writeFileSync(
        schedulerLogPath(job),
        `slurm_job=${job.id}\nstate=${job.state}\n`,
      );
    }
    const resultPath = join(job.taskDir, 'result.json');
    try {
      readFileSync(resultPath);
    } catch {
      writeFileSync(resultPath, JSON.stringify({ outputs: [], metrics: [] }));
    }
  }
}

function schedulerLogPath(job: FakeJob): string {
  return job.outputTemplate.replace('%j', job.id).replace('%A', job.id);
}

function isActive(state: string): boolean {
  return ['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING'].includes(state);
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
    const withEquals = /^--job(?:s)?=(.+)$/.exec(value);
    if (withEquals) return withEquals[1];
  }
  const index = args.findIndex((value) => value === '-j' || value === '--job' || value === '--jobs');
  return index >= 0 ? args[index + 1] : undefined;
}
