import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Fixtures shared by integration, orchestrator, and browser tests. Server
 * bootstrapping helpers stay in the server test suite so this package has no
 * dependency on the server implementation.
 */
export function makeTempProject(prefix = 'sflow-fixture-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Creates a Project directory with a few user files for explorer tests. */
export function makeProjectWithFiles(): { root: string; files: string[] } {
  const root = makeTempProject();
  mkdirSync(join(root, 'inputs'), { recursive: true });
  writeFileSync(join(root, 'target.pdb'), 'HEADER TARGET\n');
  writeFileSync(join(root, 'inputs', 'candidates.fasta'), '>candidate-1\nMKTAYIAKQR\n');
  return { root, files: ['target.pdb', 'inputs/candidates.fasta'] };
}
