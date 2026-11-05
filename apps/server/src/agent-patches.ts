import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AgentPatchParamsSchema,
  AgentPatchProposalRequestSchema,
  ApplyAgentPatchRequestSchema,
  BINDER_REQUIRED_OUTPUTS,
  JsonPatchError,
  RejectAgentPatchRequestSchema,
  ResultViewIRSchema,
  RevertAgentPatchRequestSchema,
  RunParamsSchema,
  WorkflowIRSchema,
  WorkflowParamsSchema,
  applyJsonPatch,
  describeJsonPatchOperations,
  validateResultViewBindings,
  validateWorkflow,
  type AgentPatch,
  type AgentPatchDiffEntry,
  type AgentPatchTarget,
  type AgentPatchValidation,
  type JsonPatchApplication,
  type JsonPatchOperation,
  type NodeManifest,
  type ResultViewData,
  type ResultViewIR,
  type Run,
  type ValidationDiagnostic,
  type WidgetDescriptor,
} from '@sflow/domain';
import { HttpError, parseOrThrow } from './errors';
import type { NodeCatalogReader } from './node-catalog';
import type { ProjectStore, ResultViewEntry } from './store';
import { builtinWidgetDescriptors } from './widgets';

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

function patchApplicationDiagnostic(
  error: JsonPatchError,
  documentPath = 'workflow',
): ValidationDiagnostic {
  return {
    severity: 'error',
    code: 'PATCH_APPLICATION_ERROR',
    message: error.message,
    path: error.path || documentPath,
    correction:
      'Correct the failing operation path or value and propose the patch again.',
  };
}

/** Applies a proposal to a copy and validates schema plus scientific semantics. */
function evaluateWorkflowPatch(
  workflow: unknown,
  operations: readonly JsonPatchOperation[],
  manifests: readonly NodeManifest[],
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
  const semantic = validateWorkflow(application.result, manifests, {
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
  document: 'Workflow draft' | 'Result View' = 'Workflow draft',
): HttpError {
  const basis = kind === 'baseRevision' ? 'proposed against' : 'applied to';
  return new HttpError(
    409,
    'STALE_BASE',
    `The patch was ${basis} ${document} revision ${patchRevision}, but the ${document} is now at revision ${currentRevision}. The patch was not rebased; propose it again against the current ${document}.`,
    { [kind]: patchRevision, currentRevision },
  );
}

function requireWorkflowPatchScope(patch: Pick<AgentPatch, 'scope'>): void {
  if (patch.scope !== 'workflow') {
    throw new HttpError(
      422,
      'UNSUPPORTED_SCOPE',
      'Result View Agent patches are proposed against the Run that owns the Result View, not the Workflow.',
    );
  }
}

/**
 * Applies a proposal to a copy of the persisted Result View IR, then runs the
 * same strict schema and binding-compatibility checks the read route uses.
 * Layout, selection, and other presentation state can never pass the strict
 * schema, so they can never enter the durable IR.
 */
function evaluateResultViewPatch(
  entry: ResultViewEntry,
  operations: readonly JsonPatchOperation[],
  data: ResultViewData,
  widgets: readonly WidgetDescriptor[],
): PatchEvaluation {
  const diff = describeJsonPatchOperations(entry.resultView, operations);

  let application: JsonPatchApplication;
  try {
    application = applyJsonPatch(entry.resultView, operations);
  } catch (error) {
    if (!(error instanceof JsonPatchError)) throw error;
    return {
      diff,
      validation: {
        valid: false,
        schemaValid: false,
        semanticValid: false,
        diagnostics: [patchApplicationDiagnostic(error, 'resultView')],
      },
    };
  }

  const schema = ResultViewIRSchema.safeParse(application.result);
  if (!schema.success) {
    return {
      application,
      diff,
      validation: {
        valid: false,
        schemaValid: false,
        // Binding rules cannot be evaluated when the strict schema fails.
        semanticValid: false,
        diagnostics: schema.error.issues.map((issue): ValidationDiagnostic => {
          const path = issue.path.map(String).join('.');
          const unrecognizedKey = issue.message.match(
            /Unrecognized key: "(.+?)"/,
          )?.[1];
          const pathString = path || unrecognizedKey || 'resultView';
          return {
            severity: 'error',
            code: 'INVALID_RESULT_VIEW',
            message: `The Result View is invalid at "${pathString}": ${issue.message}`,
            path: pathString,
            correction:
              'Correct the failing Result View field and propose the patch again.',
          };
        }),
      },
    };
  }

  const identityDiagnostics: ValidationDiagnostic[] = [];
  if (schema.data.runId !== entry.resultView.runId) {
    identityDiagnostics.push({
      severity: 'error',
      code: 'INVALID_RESULT_VIEW',
      message: `The patch changes the Result View Run from "${entry.resultView.runId}" to "${schema.data.runId}".`,
      path: 'runId',
      correction: 'Keep the Result View bound to the Run that owns it.',
    });
  }
  if (schema.data.id !== entry.resultView.id) {
    identityDiagnostics.push({
      severity: 'error',
      code: 'INVALID_RESULT_VIEW',
      message: `The patch changes the Result View identity from "${entry.resultView.id}" to "${schema.data.id}".`,
      path: 'id',
      correction: 'Keep the Result View identity stable while patching its blocks.',
    });
  }

  const compatibility = validateResultViewBindings(schema.data, data, widgets);
  const bindingDiagnostics = compatibility.rejected.map(
    (block): ValidationDiagnostic => ({
      severity: 'error',
      code: 'RESULT_VIEW_BINDING',
      message: `Result View block "${block.blockId}"${block.widgetId ? ` (Widget "${block.widgetId}")` : ''} is incompatible: ${block.reason}`,
      path: `blocks.${block.blockId}`,
      correction:
        'Bind the block to a Widget that accepts the Run data schemas, or remove the block.',
    }),
  );
  const diagnostics = [...identityDiagnostics, ...bindingDiagnostics];

  return {
    application,
    diff,
    validation: {
      valid: diagnostics.length === 0,
      schemaValid: true,
      semanticValid: diagnostics.length === 0,
      diagnostics,
    },
  };
}

/** Current Run data and Widget registry used to validate Result View bindings. */
function resultViewContext(
  store: ProjectStore,
  run: Run,
): { data: ResultViewData; widgets: WidgetDescriptor[] } {
  return {
    data: {
      run,
      tasks: store.listTasks(run.id),
      artifacts: store.listArtifacts(run.id),
      metrics: store.listMetrics(run.id),
    },
    widgets: [...builtinWidgetDescriptors],
  };
}

function requireResultViewEntry(store: ProjectStore, runId: string): ResultViewEntry {
  const entry = store.getResultViewEntry(runId);
  if (!entry) {
    throw new HttpError(404, 'NOT_FOUND', 'Result View not found.');
  }
  return entry;
}

function resultViewPatchRunId(patch: AgentPatch): string {
  if (patch.target.kind !== 'result-view' || !patch.target.runId) {
    throw new HttpError(
      422,
      'INVALID_TARGET',
      'The Result View patch does not identify its Run.',
    );
  }
  return patch.target.runId;
}

export function registerAgentPatchRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  catalog: NodeCatalogReader,
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

    const evaluation = evaluateWorkflowPatch(
      draft.workflow,
      proposal.operations,
      catalog.listManifests(),
    );
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

  /**
   * Result View patches are scoped to the Run that owns the page, because
   * binding compatibility depends on that Run's current data and Widgets.
   */
  app.post('/api/runs/:id/agent/patches', async (request, reply) => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const proposal = parseOrThrow(AgentPatchProposalRequestSchema, request.body);

    if (proposal.scope !== 'result-view' || proposal.target.kind !== 'result-view') {
      throw new HttpError(
        422,
        'INVALID_TARGET',
        `Patches proposed against a Run must target its Result View.`,
      );
    }

    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    const entry = requireResultViewEntry(store, id);

    if (proposal.target.runId !== undefined && proposal.target.runId !== id) {
      throw new HttpError(
        422,
        'INVALID_TARGET',
        `The patch target must identify the Run "${id}" that owns this Result View.`,
      );
    }
    if (proposal.target.resultViewId !== entry.resultView.id) {
      throw new HttpError(
        422,
        'INVALID_TARGET',
        `The patch target must identify Result View "${entry.resultView.id}".`,
      );
    }
    if (entry.revision !== proposal.baseRevision) {
      throw staleBaseError(
        proposal.baseRevision,
        entry.revision,
        'baseRevision',
        'Result View',
      );
    }

    const target: AgentPatchTarget = {
      kind: 'result-view',
      resultViewId: entry.resultView.id,
      runId: id,
    };
    const { data, widgets } = resultViewContext(store, run);
    const evaluation = evaluateResultViewPatch(
      entry,
      proposal.operations,
      data,
      widgets,
    );
    const now = new Date().toISOString();
    const patch = store.saveAgentPatch({
      id: randomUUID(),
      workflowId: run.workflowId,
      scope: proposal.scope,
      target,
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
    if (patch.status !== 'proposed') {
      throw new HttpError(
        409,
        'PATCH_NOT_APPLICABLE',
        `Only a proposed patch can be applied; this patch is ${patch.status}.`,
      );
    }

    if (patch.scope === 'result-view') {
      const runId = resultViewPatchRunId(patch);
      const run = store.getRun(runId);
      if (!run) {
        throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
      }
      const entry = requireResultViewEntry(store, runId);
      if (entry.revision !== patch.baseRevision) {
        throw staleBaseError(
          patch.baseRevision,
          entry.revision,
          'baseRevision',
          'Result View',
        );
      }

      const { data, widgets } = resultViewContext(store, run);
      const evaluation = evaluateResultViewPatch(
        entry,
        patch.operations,
        data,
        widgets,
      );
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
          'The patch no longer passes Result View validation and was not applied.',
          { diagnostics: evaluation.validation.diagnostics, patch: rejected },
        );
      }

      const resultView = ResultViewIRSchema.parse(evaluation.application.result);
      const saved = store.saveResultView(resultView, entry.revision + 1);
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

      return {
        patch: applied,
        resultView: saved.resultView,
        revision: saved.revision,
      };
    }

    requireWorkflowPatchScope(patch);
    const draft = store.getDraft(patch.workflowId);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }
    if (draft.revision !== patch.baseRevision) {
      throw staleBaseError(patch.baseRevision, draft.revision, 'baseRevision');
    }

    // Apply re-validates against the current draft: a patch that once passed
    // must still pass before it can mutate persisted Workflow IR.
    const evaluation = evaluateWorkflowPatch(
      draft.workflow,
      patch.operations,
      catalog.listManifests(),
    );
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
    if (patch.status !== 'applied') {
      throw new HttpError(
        409,
        'PATCH_NOT_APPLIED',
        `Only an applied patch can be reverted; this patch is ${patch.status}.`,
      );
    }

    if (patch.scope === 'result-view') {
      const runId = resultViewPatchRunId(patch);
      const run = store.getRun(runId);
      if (!run) {
        throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
      }
      const entry = requireResultViewEntry(store, runId);
      if (patch.resultRevision === null || entry.revision !== patch.resultRevision) {
        throw staleBaseError(
          patch.resultRevision ?? patch.baseRevision,
          entry.revision,
          'appliedRevision',
          'Result View',
        );
      }

      let revertedResultView: unknown;
      try {
        revertedResultView = applyJsonPatch(
          entry.resultView,
          patch.inverseOperations,
        ).result;
      } catch (error) {
        if (!(error instanceof JsonPatchError)) throw error;
        throw new HttpError(
          409,
          'PATCH_REVERT_FAILED',
          'The stored rollback operations could not be applied to the current Result View.',
          { diagnostics: [patchApplicationDiagnostic(error, 'resultView')] },
        );
      }

      const parsed = ResultViewIRSchema.safeParse(revertedResultView);
      if (!parsed.success) {
        throw new HttpError(
          409,
          'PATCH_REVERT_FAILED',
          'Rolling back the patch would produce an invalid Result View IR.',
          {
            diagnostics: parsed.error.issues.map(
              (issue): ValidationDiagnostic => ({
                severity: 'error',
                code: 'INVALID_RESULT_VIEW',
                message: issue.message,
                path: issue.path.map(String).join('.') || 'resultView',
                correction:
                  'Keep the restored Result View within the strict Result View contract.',
              }),
            ),
          },
        );
      }

      // Restoring the exact prior page is always allowed; binding diagnostics
      // are recorded for transparency but do not block the rollback.
      const { data, widgets } = resultViewContext(store, run);
      const compatibility = validateResultViewBindings(parsed.data, data, widgets);
      const diagnostics = compatibility.rejected.map(
        (block): ValidationDiagnostic => ({
          severity: 'error',
          code: 'RESULT_VIEW_BINDING',
          message: `Result View block "${block.blockId}" is incompatible: ${block.reason}`,
          path: `blocks.${block.blockId}`,
          correction:
            'Bind the block to a Widget that accepts the Run data schemas, or remove the block.',
        }),
      );
      const saved = store.saveResultView(parsed.data, entry.revision + 1);
      const now = new Date().toISOString();
      const reverted = store.saveAgentPatch({
        ...patch,
        status: 'reverted',
        validation: {
          valid: diagnostics.length === 0,
          schemaValid: true,
          semanticValid: diagnostics.length === 0,
          diagnostics,
        },
        revertedAt: now,
        updatedAt: now,
      });

      return {
        patch: reverted,
        resultView: saved.resultView,
        revision: saved.revision,
      };
    }

    requireWorkflowPatchScope(patch);
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

    const revertManifests = catalog.listManifests();
    const parsed = WorkflowIRSchema.safeParse(revertedWorkflow);
    if (!parsed.success) {
      throw new HttpError(
        409,
        'PATCH_REVERT_FAILED',
        'Rolling back the patch would produce an invalid Workflow IR.',
        {
          diagnostics: validateWorkflow(revertedWorkflow, revertManifests).diagnostics,
        },
      );
    }

    // Revert restores the exact prior execution state. Semantic diagnostics
    // are recorded for transparency but do not block restoring a draft that
    // existed before the patch was applied.
    const validation = validateWorkflow(parsed.data, revertManifests, {
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
