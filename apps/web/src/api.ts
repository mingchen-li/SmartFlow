import type {
  ErrorResponse,
  FileListResponse,
  FileReference,
  FileReferenceListResponse,
  LoginResponse,
  NodeCatalogResponse,
  Project,
  RotateCredentialResponse,
  SaveWorkflowDraftRequest,
  SessionResponse,
  WorkflowDraft,
} from '@sflow/domain';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body) headers.set('content-type', 'application/json');

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}.`;
    let code = 'REQUEST_FAILED';

    try {
      const body = (await response.json()) as ErrorResponse;
      if (body.error) {
        message = body.error.message;
        code = body.error.code;
      }
    } catch {
      // Non-JSON error response; keep the status-based message.
    }

    throw new ApiError(response.status, message, code);
  }

  return (await response.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function getSession(): Promise<SessionResponse> {
  return apiGet<SessionResponse>('/api/auth/session');
}

export function login(credential: string): Promise<LoginResponse> {
  return apiPost<LoginResponse>('/api/auth/login', { credential });
}

export function logout(): Promise<{ authenticated: false }> {
  return apiPost<{ authenticated: false }>('/api/auth/logout', {});
}

export function rotateCredential(
  currentCredential: string,
  newCredential: string,
): Promise<RotateCredentialResponse> {
  return apiPost<RotateCredentialResponse>('/api/auth/rotate', {
    currentCredential,
    newCredential,
  });
}

export function getProject(): Promise<Project> {
  return apiGet<Project>('/api/project');
}

export function listFiles(path = ''): Promise<FileListResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return apiGet<FileListResponse>(`/api/files${query}`);
}

/** Records a Project file by path; SFlow never copies or hashes its bytes. */
export function registerFileReference(path: string): Promise<FileReference> {
  return apiPost<FileReference>('/api/files', { path });
}

export function listFileReferences(): Promise<FileReferenceListResponse> {
  return apiGet<FileReferenceListResponse>('/api/files/references');
}

export function listNodeManifests(): Promise<NodeCatalogResponse> {
  return apiGet<NodeCatalogResponse>('/api/nodes');
}

export function getWorkflow(id: string): Promise<WorkflowDraft> {
  return apiGet<WorkflowDraft>(`/api/workflows/${encodeURIComponent(id)}`);
}

export function saveWorkflow(
  id: string,
  input: SaveWorkflowDraftRequest,
): Promise<WorkflowDraft> {
  return apiPut<WorkflowDraft>(`/api/workflows/${encodeURIComponent(id)}`, input);
}
