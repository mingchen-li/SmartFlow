import { z } from 'zod';
import { NodeEnvironmentSchema, type RetryPolicy } from './workflow';
import { RunFileReferenceSchema, RunSchema } from './run';

/**
 * Execution and scientific-record contracts (ticket #7).
 *
 * Task state vocabulary is fixed. Logs are line-oriented files; Run events are
 * append-only rows. Managed Artifacts and Metrics are immutable scientific
 * records carrying Provenance back to the Run, Task attempt, Node Manifest
 * version, inputs, parameters, and environment.
 */

export const TASK_STATES = ['queued', 'running', 'completed', 'failed', 'canceled'] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TASK_TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'canceled'];

/**
 * How an executor classified a Node failure. Only `transient`, `timeout`, and
 * `exit-code` are ever eligible for a Manifest retry; parameter and validation
 * errors are deterministic and must never be repeated.
 */
export const NODE_FAILURE_KINDS = [
  'parameter',
  'validation',
  'transient',
  'timeout',
  'exit-code',
  'unknown',
] as const;
export const NodeFailureKindSchema = z.enum(NODE_FAILURE_KINDS);
export type NodeFailureKind = z.infer<typeof NodeFailureKindSchema>;

/** Failure kinds a Manifest RetryPolicy may opt into. */
export const RETRYABLE_FAILURE_KINDS: readonly NodeFailureKind[] = [
  'transient',
  'timeout',
  'exit-code',
];

/**
 * Decides whether another Task attempt may be scheduled for a failed attempt.
 * `attempt` is one-based and counts the failed attempt. Parameter and
 * validation failures never match a RetryPolicy, even when the policy lists a
 * retryable kind with the same name.
 */
export function shouldRetryTask(
  retry: RetryPolicy,
  attempt: number,
  failureKind: NodeFailureKind,
): boolean {
  if (attempt >= retry.maxAttempts) return false;
  if (!RETRYABLE_FAILURE_KINDS.includes(failureKind)) return false;
  return retry.retryOn.includes(failureKind as 'transient' | 'timeout' | 'exit-code');
}

export const RUN_EVENT_TYPES = [
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'run.canceled',
  'run.rerun',
  'task.queued',
  'task.running',
  'task.completed',
  'task.failed',
  'task.canceled',
  'task.retry.scheduled',
  'artifact.recorded',
  'metric.recorded',
] as const;
export const RunEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

/** A namespaced, versioned scientific schema identity. */
export const SchemaRefSchema = z.strictObject({
  namespace: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
});
export type SchemaRef = z.infer<typeof SchemaRefSchema>;

/**
 * Execution Provenance. One record explains every Artifact and Metric a Task
 * attempt produced. `inputs.artifacts` holds upstream Artifact ids; file
 * inputs stay path-backed File References.
 */
export const ProvenanceSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  attempt: z.number().int().min(1),
  manifestId: z.string().min(1),
  manifestVersion: z.string().min(1),
  inputs: z.strictObject({
    artifacts: z.array(z.string().min(1)),
    fileReferences: z.array(RunFileReferenceSchema),
  }),
  parameters: z.record(z.string(), z.unknown()),
  environment: NodeEnvironmentSchema,
  executor: z.strictObject({
    kind: z.enum(['local', 'slurm']),
    jobId: z.string().min(1),
  }),
  createdAt: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * An immutable managed Node output. `path` is the Task namespace path relative
 * to the Project root; `sha256` is the content identity of the recorded bytes.
 */
export const ArtifactSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  name: z.string().min(1).max(300),
  mediaType: z.string().min(1).max(200),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Use a lowercase SHA-256 hex digest.'),
  size: z.number().int().nonnegative(),
  schema: SchemaRefSchema.optional(),
  provenance: ProvenanceSchema,
  createdAt: z.string().min(1),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const MetricValueTypeSchema = z.enum(['number', 'string', 'boolean']);
export type MetricValueType = z.infer<typeof MetricValueTypeSchema>;

export const MetricScaleSchema = z.strictObject({
  min: z.number().optional(),
  max: z.number().optional(),
});
export type MetricScale = z.infer<typeof MetricScaleSchema>;

/**
 * A typed scientific measurement. `metricId` is the producing Manifest's
 * Metric id; `schema` makes its meaning namespaced and versioned so values with
 * different meanings are never implicitly merged.
 */
export const MetricSchema = z
  .strictObject({
    id: z.string().min(1),
    runId: z.string().min(1),
    taskId: z.string().min(1),
    nodeId: z.string().min(1),
    metricId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    meaning: z.string().min(1).max(2_000),
    valueType: MetricValueTypeSchema,
    value: z.union([z.number(), z.string(), z.boolean()]),
    unit: z.string().min(1).max(200).optional(),
    scale: MetricScaleSchema.optional(),
    direction: z.enum(['higher-is-better', 'lower-is-better', 'neutral']).optional(),
    schema: SchemaRefSchema,
    provenance: ProvenanceSchema,
    createdAt: z.string().min(1),
  })
  .superRefine((metric, context) => {
    if (typeof metric.value !== metric.valueType) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Metric value must be a ${metric.valueType}.`,
      });
    }
  });
export type Metric = z.infer<typeof MetricSchema>;

/**
 * One atomic Node attempt. A rerun creates a new attempt; prior attempts stay
 * visible. `logsAvailable` is derived from the line-oriented log file.
 */
export const TaskSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  label: z.string().min(1).max(200),
  manifestId: z.string().min(1),
  manifestVersion: z.string().min(1),
  attempt: z.number().int().min(1),
  state: TaskStateSchema,
  jobId: z.string().min(1).optional(),
  /** Executor classification of the failure that ended this attempt. */
  failureKind: NodeFailureKindSchema.optional(),
  logsAvailable: z.boolean(),
  logsPath: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  error: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunEventSchema = z.strictObject({
  id: z.number().int().positive(),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  type: RunEventTypeSchema,
  payload: z.unknown().optional(),
  createdAt: z.string().min(1),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunDetailResponseSchema = z.strictObject({
  run: RunSchema,
  tasks: z.array(TaskSchema),
  artifacts: z.array(ArtifactSchema),
  metrics: z.array(MetricSchema),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const RunTaskParamsSchema = z.object({
  id: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
});
export type RunTaskParams = z.infer<typeof RunTaskParamsSchema>;

/**
 * Cancellation is idempotent: canceling an already terminal Run returns its
 * current state unchanged, so completed science is never rewritten.
 */
export const CancelRunResponseSchema = z.strictObject({ run: RunSchema });
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RerunTaskRequestSchema = z.strictObject({});
export type RerunTaskRequest = z.infer<typeof RerunTaskRequestSchema>;

/**
 * An explicit rerun creates a fresh Task attempt for the Node while the
 * original failed or canceled attempt stays visible as history.
 */
export const RerunTaskResponseSchema = z.strictObject({
  run: RunSchema,
  task: TaskSchema,
});
export type RerunTaskResponse = z.infer<typeof RerunTaskResponseSchema>;

export const RunArtifactParamsSchema = z.object({
  id: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200),
});
export type RunArtifactParams = z.infer<typeof RunArtifactParamsSchema>;

export const TaskLogsResponseSchema = z.strictObject({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  available: z.boolean(),
  logsPath: z.string().min(1).optional(),
  lines: z.array(z.string()),
});
export type TaskLogsResponse = z.infer<typeof TaskLogsResponseSchema>;

export const RunEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;

export const RunEventsResponseSchema = z.strictObject({
  events: z.array(RunEventSchema),
});
export type RunEventsResponse = z.infer<typeof RunEventsResponseSchema>;

/** Derived Project state: a Project is running while any Run is active. */
export function isActiveRunStatus(status: z.infer<typeof RunSchema>['status']): boolean {
  return status === 'queued' || status === 'running';
}
