import { z } from 'zod';
import {
  JsonPatchOperationSchema,
  formatJsonPointer,
  resolveJsonPointer,
  type JsonPatchOperation,
} from './json-patch';
import { ValidationDiagnosticSchema } from './workflow-validation';
import { WorkflowIRSchema } from './workflow';
import { ResultViewIRSchema } from './result-view';

/**
 * Agent mutation contracts (ADR-0005, ticket #15).
 *
 * Every Agent-originated change is a typed RFC 6902 patch against Workflow IR
 * or Result View IR. A patch is proposed, validated, previewed, explicitly
 * applied, and can be reverted. There is deliberately no direct Agent write
 * route outside this boundary.
 */

export const AgentPatchScopeSchema = z.enum(['workflow', 'result-view']);
export type AgentPatchScope = z.infer<typeof AgentPatchScopeSchema>;

export const AgentPatchTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workflow'),
    workflowId: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    kind: z.literal('result-view'),
    resultViewId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200).optional(),
  }),
]);
export type AgentPatchTarget = z.infer<typeof AgentPatchTargetSchema>;

export const AgentPatchStatusSchema = z.enum([
  'proposed',
  'applied',
  'rejected',
  'reverted',
]);
export type AgentPatchStatus = z.infer<typeof AgentPatchStatusSchema>;

export const AgentPatchValidationSchema = z.strictObject({
  valid: z.boolean(),
  schemaValid: z.boolean(),
  semanticValid: z.boolean(),
  diagnostics: z.array(ValidationDiagnosticSchema),
});
export type AgentPatchValidation = z.infer<typeof AgentPatchValidationSchema>;

export const AgentPatchOperationKindSchema = z.enum([
  'add',
  'remove',
  'replace',
  'move',
  'copy',
  'test',
]);
export type AgentPatchOperationKind = z.infer<typeof AgentPatchOperationKindSchema>;

/**
 * One human-readable diff line. `before`/`after` retain the exact JSON values
 * where they can be resolved from the pre-patch document.
 */
export const AgentPatchDiffEntrySchema = z.strictObject({
  operation: z.number().int().nonnegative(),
  op: AgentPatchOperationKindSchema,
  path: z.string(),
  description: z.string().min(1),
  from: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AgentPatchDiffEntry = z.infer<typeof AgentPatchDiffEntrySchema>;

export const AgentPatchSchema = z.strictObject({
  id: z.string().min(1).max(200),
  workflowId: z.string().min(1).max(200),
  scope: AgentPatchScopeSchema,
  target: AgentPatchTargetSchema,
  baseRevision: z.number().int().nonnegative(),
  resultRevision: z.number().int().nonnegative().nullable(),
  summary: z.string().min(1).max(2_000),
  operations: z.array(JsonPatchOperationSchema).min(1),
  /** Inverse operations captured at apply time; used only by safe rollback. */
  inverseOperations: z.array(JsonPatchOperationSchema).default([]),
  status: AgentPatchStatusSchema,
  validation: AgentPatchValidationSchema,
  diff: z.array(AgentPatchDiffEntrySchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  appliedAt: z.string().min(1).nullable(),
  revertedAt: z.string().min(1).nullable(),
});
export type AgentPatch = z.infer<typeof AgentPatchSchema>;

export const AgentPatchProposalRequestSchema = z
  .strictObject({
    scope: AgentPatchScopeSchema,
    target: AgentPatchTargetSchema,
    baseRevision: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_000),
    operations: z.array(JsonPatchOperationSchema).min(1).max(100),
  })
  .superRefine((proposal, context) => {
    if (proposal.scope !== proposal.target.kind) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'The patch target must match the declared scope.',
      });
    }
  });
export type AgentPatchProposalRequest = z.infer<typeof AgentPatchProposalRequestSchema>;

export const AgentPatchParamsSchema = z.object({
  id: z.string().min(1).max(200),
});
export type AgentPatchParams = z.infer<typeof AgentPatchParamsSchema>;

/** Empty body schemas keep the mutation endpoints strict. */
export const ApplyAgentPatchRequestSchema = z.strictObject({});
export type ApplyAgentPatchRequest = z.infer<typeof ApplyAgentPatchRequestSchema>;
export const RejectAgentPatchRequestSchema = z.strictObject({});
export type RejectAgentPatchRequest = z.infer<typeof RejectAgentPatchRequestSchema>;
export const RevertAgentPatchRequestSchema = z.strictObject({});
export type RevertAgentPatchRequest = z.infer<typeof RevertAgentPatchRequestSchema>;

export const AgentPatchResponseSchema = z.strictObject({ patch: AgentPatchSchema });
export type AgentPatchResponse = z.infer<typeof AgentPatchResponseSchema>;

/**
 * Apply and revert return the persisted Workflow and its new draft revision so
 * the Web client can synchronize without replacing EditorLayout or selection.
 */
export const AgentPatchWorkflowResponseSchema = z.strictObject({
  patch: AgentPatchSchema,
  workflow: WorkflowIRSchema,
  revision: z.number().int().nonnegative(),
});
export type AgentPatchWorkflowResponse = z.infer<typeof AgentPatchWorkflowResponseSchema>;

/**
 * Result View apply and revert return the patched IR with its new persisted
 * revision. The revision is row metadata; the strict Result View IR shape is
 * unchanged.
 */
export const AgentPatchResultViewResponseSchema = z.strictObject({
  patch: AgentPatchSchema,
  resultView: ResultViewIRSchema,
  revision: z.number().int().nonnegative(),
});
export type AgentPatchResultViewResponse = z.infer<
  typeof AgentPatchResultViewResponseSchema
>;

/** Response shape of applying or reverting any scoped Agent patch. */
export type AgentPatchApplicationResponse =
  | AgentPatchWorkflowResponse
  | AgentPatchResultViewResponse;

export const AgentPatchListResponseSchema = z.strictObject({
  patches: z.array(AgentPatchSchema),
});
export type AgentPatchListResponse = z.infer<typeof AgentPatchListResponseSchema>;

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  const serialized = JSON.stringify(value);
  return serialized.length > 90 ? `${serialized.slice(0, 87)}…` : serialized;
}

function resolvedBefore(document: unknown, path: string): unknown {
  try {
    return resolveJsonPointer(document, path);
  } catch {
    return undefined;
  }
}

/**
 * Produces the preview the Agent surface shows before application. Each entry
 * combines a readable path and value change with the original operation.
 */
export function describeJsonPatchOperations(
  document: unknown,
  operations: readonly JsonPatchOperation[],
): AgentPatchDiffEntry[] {
  return operations.map((operation, index): AgentPatchDiffEntry => {
    const readablePath = formatJsonPointer(operation.path);

    switch (operation.op) {
      case 'add': {
        const before = resolvedBefore(document, operation.path);
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          description: `Add ${readablePath}: ${formatValue(operation.value)}`,
          ...(before !== undefined ? { before } : {}),
          after: operation.value,
        };
      }
      case 'remove': {
        const before = resolvedBefore(document, operation.path);
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          description: `Remove ${readablePath}${before !== undefined ? ` (was ${formatValue(before)})` : ''}`,
          ...(before !== undefined ? { before } : {}),
        };
      }
      case 'replace': {
        const before = resolvedBefore(document, operation.path);
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          description: `Change ${readablePath}: ${formatValue(before)} → ${formatValue(operation.value)}`,
          ...(before !== undefined ? { before } : {}),
          after: operation.value,
        };
      }
      case 'move': {
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          from: operation.from,
          description: `Move ${formatJsonPointer(operation.from)} → ${readablePath}`,
          before: resolvedBefore(document, operation.from),
        };
      }
      case 'copy': {
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          from: operation.from,
          description: `Copy ${formatJsonPointer(operation.from)} → ${readablePath}`,
          before: resolvedBefore(document, operation.from),
        };
      }
      case 'test': {
        return {
          operation: index,
          op: operation.op,
          path: operation.path,
          description: `Verify ${readablePath} equals ${formatValue(operation.value)}`,
          before: resolvedBefore(document, operation.path),
        };
      }
    }
  });
}
