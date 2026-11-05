import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  BINDER_REQUIRED_OUTPUTS,
  CreateRunRequestSchema,
  RunEventsQuerySchema,
  RunParamsSchema,
  RunTaskParamsSchema,
  WorkflowParamsSchema,
  createRunSnapshot,
  validateWorkflow,
  type RunDetailResponse,
  type RunEventsResponse,
  type TaskLogsResponse,
} from '@sflow/domain';
import { builtinManifests } from '@sflow/nodes';
import type { Orchestrator } from '@sflow/orchestrator';
import { HttpError, parseOrThrow } from './errors';
import type { ProjectStore } from './store';

/**
 * Validation and Run execution seam. A Run may only start from a draft that
 * passes the shared Workflow validation; the stored snapshot is captured from
 * that exact draft and never changes when the draft does.
 *
 * Run creation schedules execution in the background and returns immediately,
 * so the client can observe Task transitions, logs, events, Artifacts, and
 * Metrics through the read routes while the Run is still active.
 */
export function registerRunRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  orchestrator: Orchestrator,
): void {
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

    // Execution is owned by the Orchestrator and stays observable after this
    // response returns. The Run snapshot was already persisted.
    orchestrator.start(run.id);

    reply.code(201);
    return { run };
  });

  app.get('/api/runs', async () => ({ runs: store.listRuns() }));

  app.get('/api/runs/:id', async (request): Promise<RunDetailResponse> => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    return {
      run,
      tasks: store.listTasks(id),
      artifacts: store.listArtifacts(id),
      metrics: store.listMetrics(id),
    };
  });

  app.get('/api/runs/:id/tasks/:taskId/logs', async (request): Promise<TaskLogsResponse> => {
    const { id, taskId } = parseOrThrow(RunTaskParamsSchema, request.params);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }

    const task = store.getTask(taskId);
    if (!task || task.runId !== id) {
      throw new HttpError(404, 'NOT_FOUND', 'Task not found.');
    }

    let lines: string[] = [];
    if (task.logsAvailable && task.logsPath) {
      try {
        const contents = readFileSync(resolve(store.root, task.logsPath), 'utf8');
        lines = contents.length === 0 ? [] : contents.replace(/\n$/, '').split('\n');
      } catch {
        lines = [];
      }
    }

    return {
      runId: id,
      taskId,
      available: task.logsAvailable,
      ...(task.logsAvailable && task.logsPath ? { logsPath: task.logsPath } : {}),
      lines,
    };
  });

  app.get('/api/runs/:id/events', async (request): Promise<RunEventsResponse> => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const { after } = parseOrThrow(RunEventsQuerySchema, request.query);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    return { events: store.listEvents(id, after) };
  });
}
