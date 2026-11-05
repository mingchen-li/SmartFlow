import type {
  Artifact,
  Metric,
  MetricSpec,
  NodeEnvironment,
  NodeFailureKind,
  NodeMetricValue,
  NodeResources,
  Provenance,
  Run,
  RunEvent,
  RunEventType,
  RunFileReference,
  SchemaRef,
  Task,
} from '@sflow/domain';

/**
 * Compute Executor and Orchestrator persistence contracts (ticket #7).
 *
 * The Orchestrator owns dependency planning, Task state, Provenance, and
 * events. A ComputeExecutor submits and monitors one atomic Node attempt. The
 * local executor implements this in-process for deterministic development and
 * tests; a Slurm executor will implement the same contract in ticket #12.
 */

export interface TaskSpec {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  /** Resolved snapshot parameters for the exact Manifest version. */
  parameters: Record<string, unknown>;
  fileReferences: RunFileReference[];
  /** Inline values arriving on this Task's data input ports. */
  inputs: Record<string, unknown>;
  resources: NodeResources;
  environment: NodeEnvironment;
  /** Absolute Task namespace directory. */
  taskDir: string;
}

export interface ExecutorArtifactFile {
  name: string;
  relativePath: string;
  mediaType: string;
  schema?: SchemaRef;
  sha256: string;
  size: number;
}

export interface ExecutorOutput {
  portId: string;
  value?: unknown;
  artifacts: ExecutorArtifactFile[];
}

/** A Node-returned Metric value resolved against its Manifest declaration. */
export interface ExecutorMetric {
  spec: MetricSpec;
  value: NodeMetricValue;
  schema: SchemaRef;
}

export interface ExecutorTaskResult {
  outputs: ExecutorOutput[];
  metrics: ExecutorMetric[];
  /** Absolute path of the line-oriented Task log file. */
  logsPath: string;
}

export interface SubmitOptions {
  signal?: AbortSignal;
}

export interface SubmitResult {
  jobId: string;
}

export interface PollResult {
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  exitCode?: number;
  error?: string;
  /** Executor classification used against the Node Manifest RetryPolicy. */
  failureKind?: NodeFailureKind;
  logs?: string[];
  result?: ExecutorTaskResult;
}

export interface ReconcileJob {
  jobId: string;
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  state: PollResult['state'];
  exitCode?: number;
  error?: string;
  failureKind?: NodeFailureKind;
}

export interface ReconcileResult {
  jobs: ReconcileJob[];
}

export interface ComputeExecutor {
  /** Identifies the Provenance executor kind. */
  readonly kind: 'local' | 'slurm';
  submit(spec: TaskSpec, options?: SubmitOptions): Promise<SubmitResult>;
  poll(jobId: string): Promise<PollResult>;
  cancel(jobId: string): Promise<void>;
  /** Reads persisted executor job state so restart recovery can rebuild Runs. */
  reconcile(runId: string): Promise<ReconcileResult>;
}

export interface NewTask {
  id?: string;
  runId: string;
  nodeId: string;
  label: string;
  manifestId: string;
  manifestVersion: string;
  attempt: number;
  state: PollResult['state'];
  logsPath?: string;
  createdAt?: string;
}

export interface TaskPatch {
  state?: PollResult['state'];
  jobId?: string;
  logsPath?: string;
  exitCode?: number;
  error?: string;
  failureKind?: NodeFailureKind;
  startedAt?: string;
  completedAt?: string;
}

/** Inline output values plus recorded Artifact ids, persisted per Task. */
export interface TaskOutputRecord {
  portId: string;
  value?: unknown;
  artifactIds: string[];
}

export interface NewArtifactRecord {
  runId: string;
  taskId: string;
  nodeId: string;
  name: string;
  mediaType: string;
  path: string;
  sha256: string;
  size: number;
  schema?: SchemaRef;
  provenance: Provenance;
  createdAt: string;
}

export interface NewMetricRecord {
  runId: string;
  taskId: string;
  nodeId: string;
  metricId: string;
  name: string;
  meaning: string;
  valueType: 'number' | 'string' | 'boolean';
  value: number | string | boolean;
  unit?: string;
  scale?: { min?: number; max?: number };
  direction?: 'higher-is-better' | 'lower-is-better' | 'neutral';
  schema: SchemaRef;
  provenance: Provenance;
  createdAt: string;
}

export interface NewRunEvent {
  runId: string;
  taskId?: string;
  type: RunEventType;
  payload?: unknown;
  createdAt?: string;
}

/**
 * Persistence seam used by the Orchestrator. `ProjectStore` implements it over
 * SQLite; orchestrator tests use an in-memory implementation. Events are
 * append-only and Artifacts/Metrics are immutable scientific records.
 */
export interface OrchestratorStore {
  getRun(runId: string): Run | undefined;
  /** Runs whose persisted status is not terminal, for startup reconciliation. */
  listActiveRuns(): Run[];
  updateRunStatus(runId: string, status: Run['status']): void;

  listTasks(runId: string): Task[];
  getTask(taskId: string): Task | undefined;
  createTask(input: NewTask): Task;
  updateTask(taskId: string, patch: TaskPatch): Task;
  saveTaskOutputs(taskId: string, outputs: TaskOutputRecord[]): void;
  getTaskOutputs(taskId: string): TaskOutputRecord[] | undefined;

  /** Existing immutable records for a Task attempt, used for idempotent replay. */
  findArtifact(taskId: string, name: string): Artifact | undefined;
  findMetric(taskId: string, metricId: string): Metric | undefined;
  recordArtifact(input: NewArtifactRecord): Artifact;
  recordMetric(input: NewMetricRecord): Metric;
  appendEvent(input: NewRunEvent): RunEvent;

  /** Absolute Run namespace directory. */
  runNamespace(runId: string): string;
  /** Absolute Task namespace directory. */
  taskNamespace(runId: string, taskId: string): string;
  /** `.sflow/runs/<runId>/tasks/<taskId>` with forward slashes. */
  taskNamespacePath(runId: string, taskId: string): string;
}
