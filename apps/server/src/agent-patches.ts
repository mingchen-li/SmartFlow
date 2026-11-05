import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AgentPatchParamsSchema,
  AgentPatchProposalRequestSchema,
  ApplyAgentPatchRequestSchema,
  BINDER_REQUIRED_OUTPUTS,
  JsonPatchError,
  RejectAgentPatchRequestSchema,
  RevertAgentPatchRequestSchema,
  WorkflowIRSchema,
  WorkflowParamsSchema,
  applyJsonPatch,
  describeJsonPatchOperations,
  validateWorkflow,
  type AgentPatch,
  type AgentPatchDiffEntry,
  type AgentPatchValidation,
  type JsonPatchApplication,
  type JsonPatchOperation,
  type ValidationDiagnostic,
} from '@sflow/domain';
import { builtinManifests } from '@sflow/nodes';
import { HttpError, parseOrThrow } from './errors';
import type { ProjectStore } from './store';

/**
 * Validated Agent patch boundary (ADR-0005, ticket #15).
 *
 * Agents never write Workflow IR directly. A proposal is applied to a copy,
 * checked with the strict Workflow IR schema and the shared `validateWorkflow`
 * semantic rules, and stored with a preview diff. Only an explicitly applied,
 * revision-matched patch reaches the draft; rollback uses the inverse
 * operations captured at apply time.
 */

interface PatchEvaluation {
  validation: AgentPatchValidation;
  diff: AgentPatchDiffEntry[];
  application?: JsonPatchApplication;
}

function patchApplicationDiagnostic(error: JsonPatchError): ValidationDiagnostic {
  return {
    severity: 'error',
    code: 'PATCH_APPLICATION_ERROR',
    message: error.message,
    path: error.path || 'workflow',
    correction:
      'Correct the failing operation path or value and propose the patch again.',
  };
}

/** Applies a proposal to a copy and validates schema plus scientific semantics. */
function evaluateWorkflowPatch(
  workflow: unknown,
  operations: readonly JsonPatchOperation[],
): PatchEvaluation {
  const diff = describeJsonPatchOperations(workflow, operations);

  let application: JsonPatchApplication;
  try {
    application = applyJsonPatch(workflow, operations);
  } catch (error) {
    if (!(error instanceof JsonPatchError)) throw error;
    return {
      diff,
      validation: {
        valid: false,
        schemaValid: false,
        semanticValid: false,
        diagnostics: [patchApplicationDiagnostic(error)],
      },
    };
  }

  const schema = WorkflowIRSchema.safeParse(application.result);
  const semantic = validateWorkflow(application.result, builtinManifests, {
    requiredOutputs: BINDER_REQUIRED_OUTPUTS,
  });

  return {
    application,
    diff,
    validation: {
      valid: schema.success && semantic.valid,
      schemaValid: schema.success,
      // Semantic rules cannot be evaluated when the strict IR schema fails.
      semanticValid: schema.success && semantic.valid,
      diagnostics: semantic.diagnostics,
    },
  };
}

function staleBaseError(
  patchRevision: number,
  currentRevision: number,
  kind: 'baseRevision' | 'appliedRevision',
): HttpError {
  const basis = kind === 'baseRevision' ? 'proposed against' : 'applied to';
  return new HttpError(
    409,
    'STALE_BASE',
    `The patch was ${basis} Workflow revision ${patchRevision}, but the draft is now at revision ${currentRevision}. The patch was not rebased; propose it again against the current Workflow.`,
    { [kind]: patchRevision, currentRevision },
  );
}

function requireWorkflowPatchScope(patch: Pick<AgentPatch, 'scope'>): void {
  if (patch.scope !== 'workflow') {
    throw new HttpError(
      422,
      'UNSUPPORTED_SCOPE',
      'Result View Agent patches are not available until the Result View model is implemented.',
    );
  }
}

export function registerAgentPatchRoutes(
  app: FastifyInstance,
  store: ProjectStore,
): void {
  app.post('/api/workflows/:id/agent/patches', async (request, reply) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    const proposal = parseOrThrow(AgentPatchProposalRequestSchema, request.body);
    requireWorkflowPatchScope(proposal);

    if (proposal.target.kind !== 'workflow' || proposal.target.workflowId !== id) {
      throw new HttpError(
        422,
        'INVALID_TARGET',
        `The patch target must identify Workflow "${id}".`,
      );
    }

    const draft = store.getDraft(id);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }
    if (draft.revision !== proposal.baseRevision) {
      throw staleBaseError(proposal.baseRevision, draft.revision, 'baseRevision');
    }

    const evaluation = evaluateWorkflowPatch(draft.workflow, proposal.operations);
    const now = new Date().toISOString();
    const patch = store.saveAgentPatch({
      id: randomUUID(),
      workflowId: id,
      scope: proposal.scope,
      target: proposal.target,
      baseRevision: proposal.baseRevision,
      resultRevision: null,
      summary: proposal.summary,
      operations: proposal.operations,
      inverseOperations: [],
      status: evaluation.validation.valid ? 'proposed' : 'rejected',
      validation: evaluation.validation,
      diff: evaluation.diff,
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      revertedAt: null,
    });

    reply.code(201);
    return { patch };
  });

  app.get('/api/agent/patches/:id', async (request) => {
    const { id } = parseOrThrow(AgentPatchParamsSchema, request.params);
    const patch = store.getAgentPatch(id);
    if (!patch) {
      throw new HttpError(404, 'NOT_FOUND', 'Agent patch not found.');
    }
    return { patch };
  });

  app.post('/api/agent/patches/:id/apply', async (request) => {
    const { id } = parseOrThrow(AgentPatchParamsSchema, request.params);
    parseOrThrow(ApplyAgentPatchRequestSchema, request.body ?? {});

    const patch = store.getAgentPatch(id);
    if (!patch) {
      throw new HttpError(404, 'NOT_FOUND', 'Agent patch not found.');
    }
    requireWorkflowPatchScope(patch);
    if (patch.status !== 'proposed') {
      throw new HttpError(
        409,
        'PATCH_NOT_APPLICABLE',
        `Only a proposed patch can be applied; this patch is ${patch.status}.`,
      );
    }

    const draft = store.getDraft(patch.workflowId);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }
    if (draft.revision !== patch.baseRevision) {
      throw staleBaseError(patch.baseRevision, draft.revision, 'baseRevision');
    }

    // Apply re-validates against the current draft: a patch that once passed
    // must still pass before it can mutate persisted Workflow IR.
    const evaluation = evaluateWorkflowPatch(draft.workflow, patch.operations);
    const now = new Date().toISOString();
    if (!evaluation.validation.valid || !evaluation.application) {
      const rejected = store.saveAgentPatch({
        ...patch,
        status: 'rejected',
        validation: evaluation.validation,
        diff: evaluation.diff,
        updatedAt: now,
      });
      throw new HttpError(
        422,
        'PATCH_VALIDATION_FAILED',
        'The patch no longer passes Workflow validation and was not applied.',
        { diagnostics: evaluation.validation.diagnostics, patch: rejected },
      );
    }

    const workflow = WorkflowIRSchema.parse(evaluation.application.result);
    const saved = store.saveDraft(patch.workflowId, {
      name: draft.name,
      workflow,
      // Applying a patch never touches layout, selection, viewport, or any
      // other presentation state.
      layout: draft.layout,
    });

    const applied = store.saveAgentPatch({
      ...patch,
      status: 'applied',
      inverseOperations: evaluation.application.inverse,
      resultRevision: saved.revision,
      validation: evaluation.validation,
      diff: evaluation.diff,
      appliedAt: now,
      updatedAt: now,
    });

    return { patch: applied, workflow, revision: saved.revision };
  });

  app.post('/api/agent/patches/:id/revert', async (request) => {
    const { id } = parseOrThrow(AgentPatchParamsSchema, request.params);
    parseOrThrow(RevertAgentPatchRequestSchema, request.body ?? {});

    const patch = store.getAgentPatch(id);
    if (!patch) {
      throw new HttpError(404, 'NOT_FOUND', 'Agent patch not found.');
    }
    requireWorkflowPatchScope(patch);
    if (patch.status !== 'applied') {
      throw new HttpError(
        409,
        'PATCH_NOT_APPLIED',
        `Only an applied patch can be reverted; this patch is ${patch.status}.`,
      );
    }

    const draft = store.getDraft(patch.workflowId);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }
    if (patch.resultRevision === null || draft.revision !== patch.resultRevision) {
      throw staleBaseError(
        patch.resultRevision ?? patch.baseRevision,
        draft.revision,
        'appliedRevision',
      );
    }

    let revertedWorkflow: unknown;
    try {
      revertedWorkflow = applyJsonPatch(draft.workflow, patch.inverseOperations).result;
    } catch (error) {
      if (!(error instanceof JsonPatchError)) throw error;
      throw new HttpError(
        409,
        'PATCH_REVERT_FAILED',
        'The stored rollback operations could not be applied to the current Workflow.',
        { diagnostics: [patchApplicationDiagnostic(error)] },
      );
    }

    const parsed = WorkflowIRSchema.safeParse(revertedWorkflow);
    if (!parsed.success) {
      throw new HttpError(
        409,
        'PATCH_REVERT_FAILED',
        'Rolling back the patch would produce an invalid Workflow IR.',
        {
          diagnostics: validateWorkflow(revertedWorkflow, builtinManifests).diagnostics,
        },
      );
    }

    // Revert restores the exact prior execution state. Semantic diagnostics
    // are recorded for transparency but do not block restoring a draft that
    // existed before the patch was applied.
    const validation = validateWorkflow(parsed.data, builtinManifests, {
      requiredOutputs: BINDER_REQUIRED_OUTPUTS,
    });
    const saved = store.saveDraft(patch.workflowId, {
      name: draft.name,
      workflow: parsed.data,
      layout: draft.layout,
    });
    const now = new Date().toISOString();
    const reverted = store.saveAgentPatch({
      ...patch,
      status: 'reverted',
      validation: {
        valid: validation.valid,
        schemaValid: true,
        semanticValid: validation.valid,
        diagnostics: validation.diagnostics,
      },
      revertedAt: now,
      updatedAt: now,
    });

    return { patch: reverted, workflow: parsed.data, revision: saved.revision };
  });

  app.post('/api/agent/patches/:id/reject', async (request) => {
    const { id } = parseOrThrow(AgentPatchParamsSchema, request.params);
    parseOrThrow(RejectAgentPatchRequestSchema, request.body ?? {});

    const patch = store.getAgentPatch(id);
    if (!patch) {
      throw new HttpError(404, 'NOT_FOUND', 'Agent patch not found.');
    }
    if (patch.status !== 'proposed') {
      throw new HttpError(
        409,
        'PATCH_NOT_APPLICABLE',
        `Only a proposed patch can be rejected; this patch is ${patch.status}.`,
      );
    }

    const now = new Date().toISOString();
    return {
      patch: store.saveAgentPatch({
        ...patch,
        status: 'rejected',
        updatedAt: now,
      }),
    };
  });
}
