import { readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  FileListQuerySchema,
  SaveWorkflowDraftRequestSchema,
  WorkflowParamsSchema,
  type FileEntry,
} from '@sflow/domain';
import { HttpError, parseOrThrow } from './errors';
import type { ProjectStore } from './store';

const SFLOW_STATE_DIRECTORY = '.sflow';

function normalizeRequestedPath(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === '.') return '';

  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new HttpError(400, 'INVALID_PATH', 'Project file paths must be relative.');
  }

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized.split('/').includes('..')) {
    throw new HttpError(400, 'INVALID_PATH', 'Project file paths must stay inside the Project.');
  }

  if (normalized.split('/').includes(SFLOW_STATE_DIRECTORY)) {
    throw new HttpError(404, 'NOT_FOUND', 'The requested path does not exist.');
  }

  return normalized;
}

/**
 * Minimal, read-only Project browsing seam used by the workspace shell. Ticket
 * #3 extends this with File References and selection state. `.sflow/` is never
 * listed or addressable.
 */
export function registerWorkspaceRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.get('/api/project', async () => store.getProject());

  app.get('/api/files', async (request) => {
    const query = parseOrThrow(FileListQuerySchema, request.query);
    const requestedPath = normalizeRequestedPath(query.path);
    const absolutePath = resolve(store.root, requestedPath);

    if (absolutePath !== store.root && !absolutePath.startsWith(`${store.root}${sep}`)) {
      throw new HttpError(400, 'INVALID_PATH', 'Project file paths must stay inside the Project.');
    }

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'The requested path does not exist.');
    }

    if (!stats.isDirectory()) {
      throw new HttpError(400, 'NOT_A_DIRECTORY', 'The requested path is not a directory.');
    }

    const dirents = await readdir(absolutePath, { withFileTypes: true });
    const entries: FileEntry[] = dirents
      .filter((dirent) => dirent.name !== SFLOW_STATE_DIRECTORY)
      .map((dirent): FileEntry => ({
        name: dirent.name,
        path: requestedPath ? `${requestedPath}/${dirent.name}` : dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return { path: requestedPath, entries };
  });

  app.get('/api/workflows/:id', async (request) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    const draft = store.getDraft(id);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }
    return draft;
  });

  app.put('/api/workflows/:id', async (request) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    const input = parseOrThrow(SaveWorkflowDraftRequestSchema, request.body);
    return store.saveDraft(id, input);
  });
}
