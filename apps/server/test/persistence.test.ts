import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, WorkflowDraft } from '@sflow/domain';
import {
  bootTestServer,
  getJson,
  login,
  putJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';

describe('Project persistence across Server restarts', () => {
  let handle: TestServerHandle | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    await handle?.close({ cleanupProject: false });
    handle = undefined;
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  });

  it('keeps Project metadata, the credential, sessions, and drafts across a restart', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sflow-persist-'));

    handle = await bootTestServer({
      projectRoot,
      credential: 'stable-credential',
    });

    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;
    const projectBefore = await readJson<Project>(
      await getJson(`${handle.url}/api/project`, cookie),
    );

    const saved = await putJson(
      `${handle.url}/api/workflows/binder-design`,
      {
        name: 'Binder design',
        workflow: { version: 1, nodes: [{ id: 'target' }], edges: [] },
        layout: { viewport: { x: 0, y: 0, zoom: 1 } },
      },
      cookie,
    );
    expect(saved.status).toBe(200);

    await handle.close({ cleanupProject: false });
    handle = undefined;

    // A restart with a different `--credential` must keep the existing one.
    handle = await bootTestServer({
      projectRoot,
      credential: 'ignored-new-credential',
    });
    expect(handle.generatedCredential).toBeUndefined();

    const projectAfter = await readJson<Project>(
      await getJson(`${handle.url}/api/project`, cookie),
    );
    expect(projectAfter.id).toBe(projectBefore.id);
    expect(projectAfter.name).toBe(projectBefore.name);
    expect(projectAfter.root).toBe(projectBefore.root);

    // The session signing secret is persisted, so the pre-restart cookie works.
    expect((await getJson(`${handle.url}/api/project`, cookie)).status).toBe(200);

    expect((await login(handle.url, 'stable-credential')).status).toBe(200);
    expect((await login(handle.url, 'ignored-new-credential')).status).toBe(401);

    const draftResponse = await getJson(`${handle.url}/api/workflows/binder-design`, cookie);
    expect(draftResponse.status).toBe(200);
    const draft = await readJson<WorkflowDraft>(draftResponse);
    expect(draft.name).toBe('Binder design');
    expect(draft.workflow).toEqual({ version: 1, nodes: [{ id: 'target' }], edges: [] });
    expect(draft.layout).toEqual({ viewport: { x: 0, y: 0, zoom: 1 } });
  });
});
