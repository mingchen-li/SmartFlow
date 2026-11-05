import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileReferenceSchema,
  type ErrorResponse,
  type FileReference,
  type FileReferenceListResponse,
} from '@sflow/domain';
import {
  bootTestServer,
  getJson,
  login,
  postJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

function containsEntryNamed(root: string, name: string): boolean {
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (dirent.name === name) return true;
    if (dirent.isDirectory() && containsEntryNamed(join(root, dirent.name), name)) return true;
  }
  return false;
}

describe('Path-backed File References', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  async function bootWithFiles(): Promise<{ cookie: string; root: string }> {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-references-'));
    mkdirSync(join(projectRoot, 'inputs'), { recursive: true });
    writeFileSync(join(projectRoot, 'target.pdb'), 'HEADER TARGET\n');
    writeFileSync(join(projectRoot, 'inputs', 'candidates.fasta'), '>candidate-1\nMKTAYIAKQR\n');

    handle = await bootTestServer({ projectRoot });
    const accepted = await login(handle.url, handle.credential);
    return { cookie: sessionCookie(accepted)!, root: projectRoot };
  }

  it('registers an existing Project file as a path-only File Reference', async () => {
    const { cookie, root } = await bootWithFiles();

    const response = await postJson(`${handle!.url}/api/files`, { path: 'target.pdb' }, cookie);
    expect(response.status).toBe(200);

    const reference = FileReferenceSchema.parse(await readJson<FileReference>(response));
    expect(reference.path).toBe('target.pdb');
    expect(reference.name).toBe('target.pdb');
    expect(reference.size).toBe(14);
    expect(reference.id).toBeTruthy();
    expect(reference.registeredAt).toBeTruthy();
    // Path-only: no content hash is part of a File Reference.
    expect(reference).not.toHaveProperty('sha256');
    expect(reference).not.toHaveProperty('hash');

    // SFlow did not copy the bytes into its managed state.
    expect(containsEntryNamed(join(root, '.sflow'), 'target.pdb')).toBe(false);

    // The Project file remains the source of truth even if it changes later.
    writeFileSync(join(root, 'target.pdb'), 'HEADER REPLACED\n');

    const listed = await getJson(`${handle!.url}/api/files/references`, cookie);
    expect(listed.status).toBe(200);
    const references = await readJson<FileReferenceListResponse>(listed);
    expect(references.references).toHaveLength(1);
    expect(references.references[0].id).toBe(reference.id);
    expect(references.references[0].path).toBe('target.pdb');
  });

  it('registers each path once and keeps references across a Server restart', async () => {
    const { cookie, root } = await bootWithFiles();

    const first = await readJson<FileReference>(
      await postJson(`${handle!.url}/api/files`, { path: 'inputs/candidates.fasta' }, cookie),
    );
    const again = await readJson<FileReference>(
      await postJson(`${handle!.url}/api/files`, { path: 'inputs/candidates.fasta' }, cookie),
    );
    expect(again.id).toBe(first.id);
    expect(again.registeredAt).toBe(first.registeredAt);

    await handle!.close({ cleanupProject: false });
    handle = undefined;

    handle = await bootTestServer({ projectRoot: root });
    const accepted = await login(handle.url, handle.credential);
    const listed = await readJson<FileReferenceListResponse>(
      await getJson(`${handle.url}/api/files/references`, sessionCookie(accepted)!),
    );
    expect(listed.references.map((reference) => reference.path)).toEqual([
      'inputs/candidates.fasta',
    ]);
    expect(listed.references[0].id).toBe(first.id);
  });

  it('rejects references that are missing, not files, outside the Project, or in SFlow state', async () => {
    const { cookie } = await bootWithFiles();

    const missing = await postJson(`${handle!.url}/api/files`, { path: 'missing.pdb' }, cookie);
    expect(missing.status).toBe(404);
    expect((await readJson<ErrorResponse>(missing)).error.code).toBe('NOT_FOUND');

    const directory = await postJson(`${handle!.url}/api/files`, { path: 'inputs' }, cookie);
    expect(directory.status).toBe(400);
    expect((await readJson<ErrorResponse>(directory)).error.code).toBe('NOT_A_FILE');

    for (const path of ['../secrets.pdb', '/etc/hosts', 'inputs/../target.pdb']) {
      const response = await postJson(`${handle!.url}/api/files`, { path }, cookie);
      expect(response.status, `path=${path}`).toBe(400);
      expect((await readJson<ErrorResponse>(response)).error.code).toBe('INVALID_PATH');
    }

    const state = await postJson(`${handle!.url}/api/files`, { path: '.sflow/sflow.db' }, cookie);
    expect(state.status).toBe(404);
    expect((await readJson<ErrorResponse>(state)).error.code).toBe('NOT_FOUND');

    const invalid = await postJson(`${handle!.url}/api/files`, {}, cookie);
    expect(invalid.status).toBe(400);
    expect((await readJson<ErrorResponse>(invalid)).error.code).toBe('VALIDATION_ERROR');

    const anonymous = await postJson(`${handle!.url}/api/files`, { path: 'target.pdb' });
    expect(anonymous.status).toBe(401);
  });
});
