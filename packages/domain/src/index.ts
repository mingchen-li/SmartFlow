import { z } from 'zod';

/**
 * Shared Project Server contracts. Later tickets extend the Workflow IR,
 * Run/Task, Artifact, Metric, and Result View schemas here; the Project Server
 * ticket only pins the authentication, Project, file-listing, and draft
 * persistence seams those tickets build on.
 */

export const ProjectStateSchema = z.enum(['idle', 'running']);
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  createdAt: z.string().min(1),
  state: ProjectStateSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.literal('SFlow'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const LoginRequestSchema = z.object({
  credential: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  authenticated: z.literal(true),
  project: ProjectSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const SessionResponseSchema = z.object({
  authenticated: z.literal(true),
  project: ProjectSchema,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const LogoutResponseSchema = z.object({
  authenticated: z.literal(false),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

export const RotateCredentialRequestSchema = z.object({
  currentCredential: z.string().min(1).max(512),
  newCredential: z.string().min(1).max(512),
});
export type RotateCredentialRequest = z.infer<typeof RotateCredentialRequestSchema>;

export const RotateCredentialResponseSchema = z.object({
  rotated: z.literal(true),
});
export type RotateCredentialResponse = z.infer<typeof RotateCredentialResponseSchema>;

export const FileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string(),
  type: z.enum(['file', 'directory']),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResponseSchema = z.object({
  path: z.string(),
  entries: z.array(FileEntrySchema),
});
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

export const FileListQuerySchema = z.object({
  path: z.string().optional(),
});
export type FileListQuery = z.infer<typeof FileListQuerySchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * Draft persistence seam for the Workflow editor (ticket #5). The Server owns
 * `id` and `updatedAt`; workflow and layout JSON are stored verbatim so later
 * tickets can tighten their schemas without changing the persistence boundary.
 */
export const WorkflowDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workflow: JsonObjectSchema,
  layout: JsonObjectSchema,
  updatedAt: z.string().min(1),
});
export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>;

export const SaveWorkflowDraftRequestSchema = z.object({
  name: z.string().min(1).max(200),
  workflow: JsonObjectSchema,
  layout: JsonObjectSchema.optional(),
});
export type SaveWorkflowDraftRequest = z.infer<typeof SaveWorkflowDraftRequestSchema>;

export const WorkflowParamsSchema = z.object({
  id: z.string().min(1).max(200),
});
export type WorkflowParams = z.infer<typeof WorkflowParamsSchema>;

/**
 * `WS /api/terminal` protocol.
 *
 * The terminal is an authenticated escape hatch: direct commands run under the
 * deployment's OS permissions and are intentionally outside Run/Task/
 * Provenance tracking. Messages are JSON frames so both sides share one typed
 * contract. Resize frames are validated and acknowledged, but the Server uses a
 * `child_process` shell rather than a PTY, so they cannot resize a live shell.
 */
export const TERMINAL_MAX_INPUT_CHARS = 64 * 1024;

export const TerminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('input'),
    data: z.string().min(1).max(TERMINAL_MAX_INPUT_CHARS),
  }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export const TerminalErrorMessageSchema = z.object({
  type: z.literal('error'),
  error: ErrorResponseSchema.shape.error,
});
export type TerminalErrorMessage = z.infer<typeof TerminalErrorMessageSchema>;

export const TerminalReadyMessageSchema = z.object({
  type: z.literal('ready'),
  cwd: z.string().min(1),
  shell: z.string().min(1),
});
export type TerminalReadyMessage = z.infer<typeof TerminalReadyMessageSchema>;

export const TerminalOutputMessageSchema = z.object({
  type: z.literal('output'),
  data: z.string(),
});
export type TerminalOutputMessage = z.infer<typeof TerminalOutputMessageSchema>;

export const TerminalResizedMessageSchema = z.object({
  type: z.literal('resized'),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});
export type TerminalResizedMessage = z.infer<typeof TerminalResizedMessageSchema>;

export const TerminalExitMessageSchema = z.object({
  type: z.literal('exit'),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type TerminalExitMessage = z.infer<typeof TerminalExitMessageSchema>;

export const TerminalServerMessageSchema = z.discriminatedUnion('type', [
  TerminalReadyMessageSchema,
  TerminalOutputMessageSchema,
  TerminalResizedMessageSchema,
  TerminalExitMessageSchema,
  TerminalErrorMessageSchema,
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;
