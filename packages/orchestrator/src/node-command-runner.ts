import { spawn } from 'node:child_process';
import type { CommandInvocation, CommandResult, CommandRunner } from './command-runner';

/**
 * Production `CommandRunner` backed by a child process.
 *
 * It is only constructed when the Slurm executor is selected for a real
 * deployment; tests inject a fake runner instead and never spawn Slurm tools.
 */
export class NodeCommandRunner implements CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
        env: { ...process.env, ...invocation.env },
        ...(invocation.signal ? { signal: invocation.signal } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code, signal) => {
        resolve({
          exitCode: code ?? (signal ? 128 : 1),
          stdout,
          stderr,
        });
      });
    });
  }
}
