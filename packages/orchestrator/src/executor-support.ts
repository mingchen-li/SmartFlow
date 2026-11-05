import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared persistence and timing helpers for Compute Executors.
 *
 * Local and Slurm executors persist one JSON job record per attempt and expose
 * line-oriented logs. They must agree on the on-disk mechanics while keeping
 * their own record shape and executor discriminator, so these helpers handle
 * only the common file and abort mechanics.
 */

/** Reads a line-oriented log file; a missing file is an empty log. */
export function readLogLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  if (contents.length === 0) return [];
  return contents.replace(/\n$/, '').split('\n');
}

/**
 * Writes one job record atomically so a Server restart never observes a
 * partially written JSON file.
 */
export function persistJobRecord(
  jobsDir: string,
  job: { readonly jobId: string },
): void {
  mkdirSync(jobsDir, { recursive: true });
  const path = join(jobsDir, `${job.jobId}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * Reads a persisted job record. `matches` decides which records this executor
 * may adopt, so Local and Slurm records in a shared jobs directory never cross
 * executor boundaries.
 */
export function readJobRecord<T>(
  path: string,
  matches: (record: T) => boolean,
): T | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as T;
    return matches(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Loads one job record by id from the executor's jobs directory. */
export function loadJobRecord<T>(
  jobsDir: string,
  jobId: string,
  matches: (record: T) => boolean,
): T | undefined {
  return readJobRecord(join(jobsDir, `${jobId}.json`), matches);
}

/** Abortable pause; resolves false when the signal aborts before the delay ends. */
export function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
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
