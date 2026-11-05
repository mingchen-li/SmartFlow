import type { FastifyInstance } from 'fastify';
import {
  BINDER_REQUIRED_OUTPUTS,
  CreateRunRequestSchema,
  RunParamsSchema,
  WorkflowParamsSchema,
  createRunSnapshot,
  validateWorkflow,
} from '@sflow/domain';
import { builtinManifests } from '@sflow/nodes';
import { HttpError, parseOrThrow } from './errors';
import type { ProjectStore } from './store';

/**
 * Validation and Run creation seam. A Run may only start from a draft that
 * passes the shared Workflow validation; the stored snapshot is captured from
 * that exact draft and never changes when the draft does.
 */
export function registerRunRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.post('/api/workflows/:id/validate', async (request) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    const draft = store.getDraft(id);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }

    return validateWorkflow(draft.workflow, builtinManifests, {
      requiredOutputs: BINDER_REQUIRED_OUTPUTS,
    });
  });

  app.post('/api/workflows/:id/runs', async (request, reply) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    parseOrThrow(CreateRunRequestSchema, request.body ?? {});

    const draft = store.getDraft(id);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }

    const validation = validateWorkflow(draft.workflow, builtinManifests, {
      requiredOutputs: BINDER_REQUIRED_OUTPUTS,
    });
    if (!validation.valid) {
      throw new HttpError(
        422,
        'VALIDATION_FAILED',
        'The Workflow draft does not pass validation.',
        { diagnostics: validation.diagnostics },
      );
    }

    const run = store.createRun({
      workflowId: id,
      snapshot: createRunSnapshot(draft.workflow, builtinManifests),
    });

    reply.code(201);
    return { run };
  });

  app.get('/api/runs', async () => ({ runs: store.listRuns() }));

  app.get('/api/runs/:id', async (request) => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    return run;
  });
}
