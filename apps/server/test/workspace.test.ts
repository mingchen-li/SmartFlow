import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ErrorResponse, FileListResponse, WorkflowDraft } from '@sflow/domain';
import {
  bootTestServer,
  getJson,
  login,
  putJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

describe('Project files and Workflow drafts', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function bootWithFiles(): Promise<{ cookie: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-files-'));
    mkdirSync(join(projectRoot, 'inputs'), { recursive: true });
    writeFileSync(join(projectRoot, 'target.pdb'), 'HEADER TARGET\n');
    writeFileSync(join(projectRoot, 'inputs', 'candidates.fasta'), '>candidate-1\nMKTAYIAKQR\n');
    writeFileSync(join(projectRoot, '.hidden'), 'hidden\n');

    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    return { cookie: sessionCookie(accepted)! };
  }

  it('lists Project directories and files without exposing SFlow state', async () => {
    const { cookie } = await bootWithFiles();

    const root = await getJson(`${handle!.url}/api/files`, cookie);
    expect(root.status).toBe(200);
    const listing = await readJson<FileListResponse>(root);

    expect(listing.path).toBe('');
    // Directories sort before files; `.sflow/` is never listed.
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'inputs',
      '.hidden',
      'target.pdb',
    ]);
    expect(listing.entries.find((entry) => entry.name === '.sflow')).toBeUndefined();
    expect(listing.entries.find((entry) => entry.name === 'inputs')?.type).toBe('directory');

    const nested = await getJson(`${handle!.url}/api/files?path=inputs`, cookie);
    const nestedListing = await readJson<FileListResponse>(nested);
    expect(nestedListing.path).toBe('inputs');
    expect(nestedListing.entries).toEqual([
      { name: 'candidates.fasta', path: 'inputs/candidates.fasta', type: 'file' },
    ]);
  });

  it('rejects paths outside the Project and SFlow state paths', async () => {
    const { cookie } = await bootWithFiles();

    for (const path of ['..', '../secrets', '/etc', '.sflow']) {
      const response = await getJson(
        `${handle!.url}/api/files?path=${encodeURIComponent(path)}`,
        cookie,
      );
      expect([400, 404], `path=${path}`).toContain(response.status);
      expect((await readJson<ErrorResponse>(response)).error.code).toMatch(
        /INVALID_PATH|NOT_FOUND/,
      );
    }

    const missing = await getJson(`${handle!.url}/api/files?path=missing`, cookie);
    expect(missing.status).toBe(404);

    const notADirectory = await getJson(`${handle!.url}/api/files?path=target.pdb`, cookie);
    expect(notADirectory.status).toBe(400);
    expect((await readJson<ErrorResponse>(notADirectory)).error.code).toBe('NOT_A_DIRECTORY');
  });

  it('persists an autosaved Workflow draft and returns it on reload', async () => {
    const { cookie } = await bootWithFiles();

    const missing = await getJson(`${handle!.url}/api/workflows/binder-design`, cookie);
    expect(missing.status).toBe(404);

    const saved = await putJson(
      `${handle!.url}/api/workflows/binder-design`,
      {
        name: 'Binder design',
        workflow: { version: 1, nodes: [], edges: [] },
        layout: { viewport: { x: 10, y: 20, zoom: 1 } },
      },
      cookie,
    );
    expect(saved.status).toBe(200);

    const created = await readJson<WorkflowDraft>(saved);
    expect(created.id).toBe('binder-design');
    expect(created.updatedAt).toBeTruthy();

    const reloaded = await getJson(`${handle!.url}/api/workflows/binder-design`, cookie);
    expect(reloaded.status).toBe(200);
    const draft = await readJson<WorkflowDraft>(reloaded);
    expect(draft.name).toBe('Binder design');
    expect(draft.layout).toEqual({ viewport: { x: 10, y: 20, zoom: 1 } });

    const renamed = await putJson(
      `${handle!.url}/api/workflows/binder-design`,
      { name: 'Binder design v2', workflow: { version: 1, nodes: [], edges: [] } },
      cookie,
    );
    expect((await readJson<WorkflowDraft>(renamed)).name).toBe('Binder design v2');
  });

  it('rejects an invalid draft payload', async () => {
    const { cookie } = await bootWithFiles();

    const invalid = await putJson(
      `${handle!.url}/api/workflows/binder-design`,
      { workflow: {} },
      cookie,
    );
    expect(invalid.status).toBe(400);
    expect((await readJson<ErrorResponse>(invalid)).error.code).toBe('VALIDATION_ERROR');
  });
});
