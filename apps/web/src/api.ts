import type {
  AgentPatchProposalRequest,
  AgentPatchResponse,
  AgentPatchWorkflowResponse,
  CreateRunResponse,
  ErrorResponse,
  FileListResponse,
  FileReference,
  FileReferenceListResponse,
  LoginResponse,
  NodeCatalogResponse,
  Project,
  RotateCredentialResponse,
  Run,
  RunListResponse,
  SaveWorkflowDraftRequest,
  SessionResponse,
  ValidateWorkflowResponse,
  WorkflowDraft,
} from '@sflow/domain';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'REQUEST_FAILED',
    readonly details?: unknown,
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
    let details: unknown;

    try {
      const body = (await response.json()) as ErrorResponse;
      if (body.error) {
        message = body.error.message;
        code = body.error.code;
        details = body.error.details;
      }
    } catch {
      // Non-JSON error response; keep the status-based message.
    }

    throw new ApiError(response.status, message, code, details);
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

/** Validates the persisted draft; callers should save edits first. */
export function validateWorkflowDraft(
  id: string,
): Promise<ValidateWorkflowResponse> {
  return apiPost<ValidateWorkflowResponse>(
    `/api/workflows/${encodeURIComponent(id)}/validate`,
    {},
  );
}

/** Starts a Run from the persisted draft; rejects with 422 when invalid. */
export function createRun(id: string): Promise<CreateRunResponse> {
  return apiPost<CreateRunResponse>(
    `/api/workflows/${encodeURIComponent(id)}/runs`,
    {},
  );
}

export function getRun(id: string): Promise<Run> {
  return apiGet<Run>(`/api/runs/${encodeURIComponent(id)}`);
}

export function listRuns(): Promise<RunListResponse> {
  return apiGet<RunListResponse>('/api/runs');
}

/**
 * Validated Agent patch boundary. A proposal is previewed and validated by the
 * Server; only an explicit apply mutates the draft Workflow IR.
 */
export function proposeAgentPatch(
  workflowId: string,
  proposal: AgentPatchProposalRequest,
): Promise<AgentPatchResponse> {
  return apiPost<AgentPatchResponse>(
    `/api/workflows/${encodeURIComponent(workflowId)}/agent/patches`,
    proposal,
  );
}

export function getAgentPatch(id: string): Promise<AgentPatchResponse> {
  return apiGet<AgentPatchResponse>(`/api/agent/patches/${encodeURIComponent(id)}`);
}

export function applyAgentPatch(id: string): Promise<AgentPatchWorkflowResponse> {
  return apiPost<AgentPatchWorkflowResponse>(
    `/api/agent/patches/${encodeURIComponent(id)}/apply`,
    {},
  );
}

export function revertAgentPatch(id: string): Promise<AgentPatchWorkflowResponse> {
  return apiPost<AgentPatchWorkflowResponse>(
    `/api/agent/patches/${encodeURIComponent(id)}/revert`,
    {},
  );
}

export function rejectAgentPatch(id: string): Promise<AgentPatchResponse> {
  return apiPost<AgentPatchResponse>(
    `/api/agent/patches/${encodeURIComponent(id)}/reject`,
    {},
  );
}
