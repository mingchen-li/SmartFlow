import type {
  AgentPatchApplicationResponse,
  AgentPatchProposalRequest,
  AgentPatchResponse,
  CreateRunResponse,
  ErrorResponse,
  FileListResponse,
  FileReference,
  FileReferenceListResponse,
  InstallNodeResponse,
  LoginResponse,
  NodeCatalogResponse,
  Project,
  ResultViewResponse,
  RotateCredentialResponse,
  CancelRunResponse,
  RerunTaskResponse,
  RunDetailResponse,
  RunEventsResponse,
  RunListResponse,
  SaveWorkflowDraftRequest,
  SessionResponse,
  TaskLogsResponse,
  UninstallNodeResponse,
  ValidateWorkflowResponse,
  WidgetCatalogResponse,
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

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
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

/**
 * Installs a Project-relative Node package directory. The Server validates the
 * Manifest and `index.mjs` before writing; a 422 carries path-addressed
 * diagnostics in `details.diagnostics`.
 */
export function installNodePackage(path: string): Promise<InstallNodeResponse> {
  return apiPost<InstallNodeResponse>('/api/nodes/install', { path });
}

/** Removes one Project-installed Node package; built-in Nodes are rejected. */
export function uninstallNodePackage(id: string): Promise<UninstallNodeResponse> {
  return apiDelete<UninstallNodeResponse>(`/api/nodes/${encodeURIComponent(id)}`);
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

/** Run detail includes Tasks, Artifacts, and Metrics while execution proceeds. */
export function getRun(id: string): Promise<RunDetailResponse> {
  return apiGet<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`);
}

export function listRuns(): Promise<RunListResponse> {
  return apiGet<RunListResponse>('/api/runs');
}

/** Append-only Run events after the last observed event id. */
export function getRunEvents(id: string, after = 0): Promise<RunEventsResponse> {
  const query = after > 0 ? `?after=${after}` : '';
  return apiGet<RunEventsResponse>(
    `/api/runs/${encodeURIComponent(id)}/events${query}`,
  );
}

/** Line-oriented logs for one Task attempt. */
export function getTaskLogs(runId: string, taskId: string): Promise<TaskLogsResponse> {
  return apiGet<TaskLogsResponse>(
    `/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/logs`,
  );
}

/** Durable Result View IR, resolved data, and compatibility report. */
export function getResultView(runId: string): Promise<ResultViewResponse> {
  return apiGet<ResultViewResponse>(
    `/api/runs/${encodeURIComponent(runId)}/result-view`,
  );
}

/** Registered Result View Widget descriptors (data only, no render code). */
export function listWidgets(): Promise<WidgetCatalogResponse> {
  return apiGet<WidgetCatalogResponse>('/api/widgets');
}

/** Authenticated, immutable Artifact bytes with an attachment filename. */
export function artifactDownloadUrl(runId: string, artifactId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(
    artifactId,
  )}/download`;
}

/**
 * Cancels queued and running work. Canceling a terminal Run is idempotent and
 * returns the unchanged Run.
 */
export function cancelRun(id: string): Promise<CancelRunResponse> {
  return apiPost<CancelRunResponse>(`/api/runs/${encodeURIComponent(id)}/cancel`, {});
}

/**
 * Reruns one failed or canceled Task attempt as a new attempt. The Server
 * rejects completed, superseded, or still-active attempts with 409.
 */
export function rerunTask(runId: string, taskId: string): Promise<RerunTaskResponse> {
  return apiPost<RerunTaskResponse>(
    `/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/rerun`,
    {},
  );
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

/**
 * Result View patches are proposed through the Run that owns the page, so
 * binding validation can use that Run's current data and Widgets.
 */
export function proposeResultViewPatch(
  runId: string,
  proposal: AgentPatchProposalRequest,
): Promise<AgentPatchResponse> {
  return apiPost<AgentPatchResponse>(
    `/api/runs/${encodeURIComponent(runId)}/agent/patches`,
    proposal,
  );
}

export function getAgentPatch(id: string): Promise<AgentPatchResponse> {
  return apiGet<AgentPatchResponse>(`/api/agent/patches/${encodeURIComponent(id)}`);
}

export function applyAgentPatch(id: string): Promise<AgentPatchApplicationResponse> {
  return apiPost<AgentPatchApplicationResponse>(
    `/api/agent/patches/${encodeURIComponent(id)}/apply`,
    {},
  );
}

export function revertAgentPatch(id: string): Promise<AgentPatchApplicationResponse> {
  return apiPost<AgentPatchApplicationResponse>(
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
