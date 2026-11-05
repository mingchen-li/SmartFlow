/**
 * Scheduler command seam for the Slurm Compute Executor.
 *
 * All scheduler invocation flows through `CommandRunner`; the executor itself
 * never imports `node:child_process`. Contract tests inject a fake runner, so
 * no real Slurm installation, network, or container runtime is required.
 */
export interface CommandInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CommandResult {
  /** Process exit status. A non-zero value is reported, not thrown. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}
