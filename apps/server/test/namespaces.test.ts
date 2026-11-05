import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer, type TestServerHandle } from './support';

describe('Project, Run, and Task namespaces', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function boot(): Promise<{ store: TestServerHandle['server']['store']; root: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-namespaces-'));
    handle = await bootTestServer({ projectRoot });
    return { store: handle.server.store, root: projectRoot };
  }

  it('keeps same-named files separate in Project, Run, and Task directories', async () => {
    const { store, root } = await boot();
    const runId = randomUUID();
    const taskId = randomUUID();

    // Project namespace: the user's Project filesystem.
    writeFileSync(join(root, 'result.pdb'), 'project-namespace');
    expect(existsSync(join(root, '.sflow', 'runs'))).toBe(true);

    const runDirectory = store.ensureRunNamespace(runId);
    expect(runDirectory).toBe(join(root, '.sflow', 'runs', runId));
    writeFileSync(join(runDirectory, 'result.pdb'), 'run-namespace');

    const taskDirectory = store.ensureTaskNamespace(runId, taskId);
    expect(taskDirectory).toBe(join(root, '.sflow', 'runs', runId, 'tasks', taskId));
    writeFileSync(join(taskDirectory, 'result.pdb'), 'task-namespace');

    expect(readFileSync(join(root, 'result.pdb'), 'utf8')).toBe('project-namespace');
    expect(readFileSync(join(runDirectory, 'result.pdb'), 'utf8')).toBe('run-namespace');
    expect(readFileSync(join(taskDirectory, 'result.pdb'), 'utf8')).toBe('task-namespace');
  });

  it('gives every Task attempt and every Run its own directory', async () => {
    const { store, root } = await boot();
    const runId = randomUUID();
    const firstTaskId = randomUUID();
    const secondTaskId = randomUUID();

    const firstAttempt = store.ensureTaskNamespace(runId, firstTaskId);
    const secondAttempt = store.ensureTaskNamespace(runId, secondTaskId);
    const otherRun = store.ensureTaskNamespace(randomUUID(), firstTaskId);

    expect(new Set([firstAttempt, secondAttempt, otherRun]).size).toBe(3);
    for (const directory of [firstAttempt, secondAttempt, otherRun]) {
      expect(existsSync(directory)).toBe(true);
      expect(directory.startsWith(join(root, '.sflow', 'runs'))).toBe(true);
    }

    // Ensuring an existing namespace is idempotent.
    expect(store.ensureRunNamespace(runId)).toBe(join(root, '.sflow', 'runs', runId));
  });

  it('rejects namespace identifiers that could escape .sflow', async () => {
    const { store } = await boot();
    const runId = randomUUID();

    for (const invalid of ['', '.', '..', '../escape', 'nested/path', 'nested\\path', '.sflow']) {
      expect(() => store.ensureRunNamespace(invalid), `run id ${invalid}`).toThrow();
      expect(() => store.ensureTaskNamespace(runId, invalid), `task id ${invalid}`).toThrow();
    }
  });
});
