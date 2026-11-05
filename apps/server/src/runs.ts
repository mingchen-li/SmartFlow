import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  BINDER_REQUIRED_OUTPUTS,
  CreateRunRequestSchema,
  RerunTaskRequestSchema,
  RunArtifactParamsSchema,
  RunEventsQuerySchema,
  RunParamsSchema,
  RunTaskParamsSchema,
  WorkflowParamsSchema,
  buildDefaultResultView,
  createRunSnapshot,
  validateResultViewBindings,
  validateWorkflow,
  type CancelRunResponse,
  type NodeRegistry,
  type RerunTaskResponse,
  type ResultViewIR,
  type ResultViewResponse,
  type Run,
  type RunDetailResponse,
  type RunEventsResponse,
  type TaskLogsResponse,
} from '@sflow/domain';
import { OrchestratorError, type Orchestrator } from '@sflow/orchestrator';
import { HttpError, parseOrThrow } from './errors';
import type { ProjectStore } from './store';
import { builtinWidgetDescriptors } from './widgets';

/**
 * Builds the default Result View for a Run. The persisted IR describes ordered
 * blocks and schema-bound selectors; it carries no frontend components and is
 * independent of the data that later resolves against it.
 */
function defaultResultView(store: ProjectStore, run: Run): ResultViewIR {
  const existing = store.getResultView(run.id);
  if (existing) return existing;
  return store.saveResultView(
    buildDefaultResultView({
      runId: run.id,
      createdAt: run.createdAt,
      widgets: builtinWidgetDescriptors,
    }),
  );
}

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
  registry: NodeRegistry,
): void {
  const manifests = registry.list().map((implementation) => implementation.manifest);

  app.post('/api/workflows/:id/validate', async (request) => {
    const { id } = parseOrThrow(WorkflowParamsSchema, request.params);
    const draft = store.getDraft(id);
    if (!draft) {
      throw new HttpError(404, 'NOT_FOUND', 'Workflow draft not found.');
    }

    return validateWorkflow(draft.workflow, manifests, {
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

    const validation = validateWorkflow(draft.workflow, manifests, {
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
      snapshot: createRunSnapshot(draft.workflow, manifests),
    });

    // Every Run owns a durable Result View from the moment it exists, before
    // execution produces any data to resolve against it.
    defaultResultView(store, run);

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

  app.get('/api/runs/:id/result-view', async (request): Promise<ResultViewResponse> => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }

    const resultView = defaultResultView(store, run);
    const data = {
      run,
      tasks: store.listTasks(id),
      artifacts: store.listArtifacts(id),
      metrics: store.listMetrics(id),
    };
    const widgets = [...builtinWidgetDescriptors];

    return {
      resultView,
      widgets,
      data,
      compatibility: validateResultViewBindings(resultView, data, widgets),
    };
  });

  app.get(
    '/api/runs/:id/artifacts/:artifactId/download',
    async (request, reply) => {
      const { id, artifactId } = parseOrThrow(RunArtifactParamsSchema, request.params);
      const run = store.getRun(id);
      if (!run) {
        throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
      }

      // Artifact lookup is scoped to the Run, so one Run can never address
      // another Run's managed output.
      const artifact = store.getArtifact(id, artifactId);
      if (!artifact) {
        throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.');
      }

      const absolute = resolve(store.root, artifact.path);
      const namespace = `.sflow/runs/${id}/tasks/`;
      const insideProject = (() => {
        const rel = relative(store.root, absolute);
        return rel.length > 0 && rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel);
      })();
      if (!artifact.path.startsWith(namespace) || !insideProject) {
        throw new HttpError(404, 'NOT_FOUND', 'Artifact not found.');
      }

      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'Artifact bytes are unavailable.');
      }

      const filename = artifact.name.replace(/["\\\r\n]/g, '_');
      return reply
        .header('content-type', artifact.mediaType)
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('content-length', String(bytes.byteLength))
        .header('x-content-type-options', 'nosniff')
        .header('etag', `"${artifact.sha256}"`)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(bytes);
    },
  );

  app.get('/api/runs/:id/events', async (request): Promise<RunEventsResponse> => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const { after } = parseOrThrow(RunEventsQuerySchema, request.query);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    return { events: store.listEvents(id, after) };
  });

  /**
   * Cancels queued work, requests running executor jobs to stop, and closes
   * the Run as canceled. Safe to call on a terminal Run: the response is the
   * unchanged Run and no history is rewritten.
   */
  app.post('/api/runs/:id/cancel', async (request): Promise<CancelRunResponse> => {
    const { id } = parseOrThrow(RunParamsSchema, request.params);
    const run = store.getRun(id);
    if (!run) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
    }
    try {
      return { run: await orchestrator.cancelRun(id) };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  /**
   * Explicitly reruns a failed or canceled Task attempt. The new attempt is
   * queued and the Run resumes; the original attempt and logs stay visible.
   */
  app.post(
    '/api/runs/:id/tasks/:taskId/rerun',
    async (request): Promise<RerunTaskResponse> => {
      const { id, taskId } = parseOrThrow(RunTaskParamsSchema, request.params);
      parseOrThrow(RerunTaskRequestSchema, request.body ?? {});
      const run = store.getRun(id);
      if (!run) {
        throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
      }
      const task = store.getTask(taskId);
      if (!task || task.runId !== id) {
        throw new HttpError(404, 'NOT_FOUND', 'Task not found.');
      }
      try {
        const result = await orchestrator.rerunTask(id, taskId);
        return { run: result.run, task: result.task };
      } catch (error) {
        throw toHttpError(error);
      }
    },
  );
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof OrchestratorError) {
    return new HttpError(409, error.code, error.message);
  }
  throw error;
}
