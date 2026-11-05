import { readdir, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  FileListQuerySchema,
  RegisterFileReferenceRequestSchema,
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

function resolveProjectPath(root: string, requestedPath: string): string {
  const absolutePath = resolve(root, requestedPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new HttpError(400, 'INVALID_PATH', 'Project file paths must stay inside the Project.');
  }
  return absolutePath;
}

/**
 * Project filesystem seam for the workspace shell. Ticket #3 adds path-backed
 * File References: selecting a file records its location, never a copy or a
 * digest. `.sflow/` is never listed or addressable.
 */
export function registerWorkspaceRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.get('/api/project', async () => store.getProject());

  app.get('/api/files/references', async () => ({ references: store.listFileReferences() }));

  app.post('/api/files', async (request) => {
    const input = parseOrThrow(RegisterFileReferenceRequestSchema, request.body);
    const requestedPath = normalizeRequestedPath(input.path);
    if (!requestedPath) {
      throw new HttpError(400, 'INVALID_PATH', 'A Project file path is required.');
    }

    const absolutePath = resolveProjectPath(store.root, requestedPath);

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', 'The requested path does not exist.');
    }

    if (!stats.isFile()) {
      throw new HttpError(400, 'NOT_A_FILE', 'The requested path is not a file.');
    }

    // Only filesystem metadata is read; contents stay in the Project.
    return store.registerFileReference({
      path: requestedPath,
      name: basename(requestedPath),
      size: stats.size,
    });
  });

  app.get('/api/files', async (request) => {
    const query = parseOrThrow(FileListQuerySchema, request.query);
    const requestedPath = normalizeRequestedPath(query.path);
    const absolutePath = resolveProjectPath(store.root, requestedPath);

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
