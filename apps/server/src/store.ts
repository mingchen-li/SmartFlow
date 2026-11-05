import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ArtifactSchema,
  MetricSchema,
  RunEventSchema,
  RunSchema,
  RunSnapshotSchema,
  TaskSchema,
  WorkflowDraftSchema,
  type Artifact,
  type FileReference,
  type Metric,
  type Project,
  type Run,
  type RunEvent,
  type RunSnapshot,
  type RunStatus,
  type SaveWorkflowDraftRequest,
  type Task,
  type WorkflowDraft,
} from '@sflow/domain';
import type {
  NewArtifactRecord,
  NewMetricRecord,
  NewRunEvent,
  NewTask,
  OrchestratorStore,
  TaskOutputRecord,
  TaskPatch,
} from '@sflow/orchestrator';

interface SettingRow {
  value: string;
}

interface DraftRow {
  id: string;
  name: string;
  draft_json: string;
  layout_json: string;
  updated_at: string;
}

interface FileReferenceRow {
  id: string;
  path: string;
  name: string;
  size: number;
  registered_at: string;
}

interface RunRow {
  id: string;
  workflow_id: string;
  snapshot_json: string;
  state: string;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  run_id: string;
  node_id: string;
  label: string;
  manifest_id: string;
  manifest_version: string;
  state: string;
  attempt: number;
  job_id: string | null;
  logs_path: string | null;
  logs_available: number;
  exit_code: number | null;
  error: string | null;
  outputs_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  task_id: string;
  node_id: string;
  name: string;
  media_type: string;
  path: string;
  sha256: string;
  size: number;
  schema_json: string | null;
  provenance_json: string;
  created_at: string;
}

interface MetricRow {
  id: string;
  run_id: string;
  task_id: string;
  node_id: string;
  metric_id: string;
  name: string;
  meaning: string;
  value_type: string;
  value_json: string;
  unit: string | null;
  scale_json: string | null;
  direction: string | null;
  schema_json: string;
  provenance_json: string;
  created_at: string;
}

interface EventRow {
  id: number;
  run_id: string;
  task_id: string | null;
  type: string;
  payload_json: string | null;
  created_at: string;
}

const SCRYPT_KEY_LENGTH = 64;
const NAMESPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Run and Task ids become directory names under `.sflow/runs`, so they must be
 * a single safe path segment. SFlow generates them with `crypto.randomUUID()`;
 * this guard also protects persisted or externally supplied ids.
 */
function requireNamespaceId(value: string, label: string): string {
  if (!NAMESPACE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} identifier for a Project namespace.`);
  }
  return value;
}

/**
 * Project-scoped persistence. The Project root is the user's directory; SFlow
 * owns `<project>/.sflow/` and never exposes it through the file explorer.
 */
export class ProjectStore implements OrchestratorStore {
  readonly root: string;
  readonly sflowDir: string;

  private readonly db: DatabaseSync;
  private closed = false;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot);
    this.sflowDir = join(this.root, '.sflow');
    mkdirSync(this.sflowDir, { recursive: true });
    mkdirSync(join(this.sflowDir, 'runs'), { recursive: true });
    mkdirSync(join(this.sflowDir, 'executor'), { recursive: true });
    mkdirSync(join(this.sflowDir, 'nodes'), { recursive: true });

    this.db = new DatabaseSync(join(this.sflowDir, 'sflow.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
    this.ensureProjectMetadata();
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as SettingRow | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /**
   * Establishes the one Project credential. A credential supplied by
   * `--credential`/`SFLOW_CREDENTIAL` is used on first start; otherwise a
   * credential is generated and returned so the CLI can print it exactly once.
   */
  initializeCredential(providedCredential?: string): { generatedCredential?: string } {
    if (this.getSetting('auth.hash')) {
      return {};
    }

    if (providedCredential !== undefined && providedCredential.length === 0) {
      throw new Error('The Project credential must not be empty.');
    }

    const generatedCredential =
      providedCredential === undefined ? randomBytes(18).toString('base64url') : undefined;
    this.setCredential(providedCredential ?? generatedCredential!);
    return generatedCredential ? { generatedCredential } : {};
  }

  setCredential(credential: string): void {
    const salt = randomBytes(16).toString('hex');
    this.setSetting('auth.algorithm', 'scrypt');
    this.setSetting('auth.salt', salt);
    this.setSetting('auth.hash', this.hashCredential(credential, salt));
  }

  verifyCredential(credential: string): boolean {
    if (this.getSetting('auth.algorithm') !== 'scrypt') return false;

    const salt = this.getSetting('auth.salt');
    const expectedHex = this.getSetting('auth.hash');
    if (!salt || !expectedHex) return false;

    try {
      const actual = scryptSync(credential, salt, SCRYPT_KEY_LENGTH);
      const expected = Buffer.from(expectedHex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  getSessionSecret(): string {
    let secret = this.getSetting('auth.sessionSecret');
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      this.setSetting('auth.sessionSecret', secret);
    }
    return secret;
  }

  getProject(): Project {
    const id = this.getSetting('project.id');
    const name = this.getSetting('project.name');
    const createdAt = this.getSetting('project.createdAt');

    if (!id || !name || !createdAt) {
      throw new Error('Project metadata is missing from the Project store.');
    }

    const active = this.db
      .prepare("SELECT 1 AS active FROM runs WHERE state IN ('queued', 'running') LIMIT 1")
      .get() as unknown as { active: number } | undefined;

    return {
      id,
      name,
      root: this.root,
      createdAt,
      // Project state is derived: any non-terminal Run means the Project is
      // running. Completed and failed Runs leave it idle.
      state: active ? 'running' : 'idle',
    };
  }

  getDraft(id: string): WorkflowDraft | undefined {
    const row = this.db
      .prepare('SELECT id, name, draft_json, layout_json, updated_at FROM workflows WHERE id = ?')
      .get(id) as unknown as DraftRow | undefined;

    if (!row) return undefined;

    try {
      const parsed = WorkflowDraftSchema.safeParse({
        id: row.id,
        name: row.name,
        workflow: JSON.parse(row.draft_json),
        layout: JSON.parse(row.layout_json),
        updatedAt: row.updated_at,
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  saveDraft(id: string, input: SaveWorkflowDraftRequest): WorkflowDraft {
    const updatedAt = new Date().toISOString();
    const layout = input.layout ?? {};

    this.db
      .prepare(
        `INSERT INTO workflows (id, name, draft_json, layout_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           draft_json = excluded.draft_json,
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at`,
      )
      .run(id, input.name, JSON.stringify(input.workflow), JSON.stringify(layout), updatedAt);

    return {
      id,
      name: input.name,
      workflow: input.workflow,
      layout,
      updatedAt,
    };
  }

  /**
   * Records a Project file by location only. The caller supplies filesystem
   * metadata from `stat`; SFlow never reads or hashes the file bytes here.
   * Registration is idempotent per path so reselecting a file does not create
   * duplicate references.
   */
  registerFileReference(input: { path: string; name: string; size: number }): FileReference {
    const existing = this.findFileReferenceByPath(input.path);
    if (existing) return existing;

    const reference: FileReference = {
      id: randomUUID(),
      path: input.path,
      name: input.name,
      size: input.size,
      registeredAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO file_references (id, path, name, size, registered_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(reference.id, reference.path, reference.name, reference.size, reference.registeredAt);

    return reference;
  }

  listFileReferences(): FileReference[] {
    const rows = this.db
      .prepare('SELECT id, path, name, size, registered_at FROM file_references ORDER BY path')
      .all() as unknown as FileReferenceRow[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      name: row.name,
      size: row.size,
      registeredAt: row.registered_at,
    }));
  }

  findFileReferenceByPath(path: string): FileReference | undefined {
    const row = this.db
      .prepare('SELECT id, path, name, size, registered_at FROM file_references WHERE path = ?')
      .get(path) as unknown as FileReferenceRow | undefined;

    if (!row) return undefined;
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      size: row.size,
      registeredAt: row.registered_at,
    };
  }

  /**
   * Persists a Run together with its immutable, Zod-validated snapshot. The
   * snapshot is the only source execution reads from; later draft or Manifest
   * changes never rewrite it.
   */
  createRun(input: {
    workflowId: string;
    snapshot: RunSnapshot;
    status?: RunStatus;
    createdAt?: string;
  }): Run {
    const snapshot = RunSnapshotSchema.parse(input.snapshot);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const run = RunSchema.parse({
      id: randomUUID(),
      workflowId: input.workflowId,
      status: input.status ?? 'queued',
      createdAt,
      updatedAt: createdAt,
      snapshot,
    });

    requireNamespaceId(run.id, 'Run');
    this.ensureRunNamespace(run.id);

    this.db
      .prepare(
        `INSERT INTO runs (id, workflow_id, snapshot_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workflowId,
        JSON.stringify(run.snapshot),
        run.status,
        run.createdAt,
        run.updatedAt,
      );

    this.appendEvent({
      runId: run.id,
      type: 'run.created',
      payload: { workflowId: run.workflowId },
      createdAt,
    });

    return run;
  }

  getRun(id: string): Run | undefined {
    requireNamespaceId(id, 'Run');
    const row = this.db
      .prepare(
        'SELECT id, workflow_id, snapshot_json, state, created_at, updated_at FROM runs WHERE id = ?',
      )
      .get(id) as unknown as RunRow | undefined;

    return row ? this.rowToRun(row) : undefined;
  }

  /** Runs are listed newest first; rowid breaks same-millisecond ties. */
  listRuns(): Run[] {
    const rows = this.db
      .prepare(
        'SELECT id, workflow_id, snapshot_json, state, created_at, updated_at FROM runs ORDER BY created_at DESC, rowid DESC',
      )
      .all() as unknown as RunRow[];

    return rows.flatMap((row) => {
      const run = this.rowToRun(row);
      return run ? [run] : [];
    });
  }

  private rowToRun(row: RunRow): Run | undefined {
    try {
      const parsed = RunSchema.safeParse({
        id: row.id,
        workflowId: row.workflow_id,
        status: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        snapshot: JSON.parse(row.snapshot_json),
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    requireNamespaceId(runId, 'Run');
    const result = this.db
      .prepare('UPDATE runs SET state = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), runId);
    if (Number(result.changes) === 0) {
      throw new Error(`Unknown Run "${runId}".`);
    }
  }

  listTasks(runId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, node_id, label, manifest_id, manifest_version, state, attempt,
                job_id, logs_path, logs_available, exit_code, error, outputs_json,
                created_at, started_at, completed_at, updated_at
         FROM tasks WHERE run_id = ? ORDER BY rowid ASC`,
      )
      .all(runId) as unknown as TaskRow[];

    return rows.flatMap((row) => {
      const task = this.rowToTask(row);
      return task ? [task] : [];
    });
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db
      .prepare(
        `SELECT id, run_id, node_id, label, manifest_id, manifest_version, state, attempt,
                job_id, logs_path, logs_available, exit_code, error, outputs_json,
                created_at, started_at, completed_at, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as unknown as TaskRow | undefined;

    return row ? this.rowToTask(row) : undefined;
  }

  createTask(input: NewTask): Task {
    const id = input.id ?? randomUUID();
    requireNamespaceId(id, 'Task');
    this.ensureTaskNamespace(input.runId, id);
    const createdAt = input.createdAt ?? new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (
           id, run_id, node_id, label, manifest_id, manifest_version, state, attempt,
           job_id, logs_path, logs_available, exit_code, error, outputs_json,
           created_at, started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.runId,
        input.nodeId,
        input.label,
        input.manifestId,
        input.manifestVersion,
        input.state,
        input.attempt,
        input.logsPath ?? null,
        createdAt,
        createdAt,
      );

    const task = this.getTask(id);
    if (!task) throw new Error('The Task could not be persisted.');
    return task;
  }

  updateTask(taskId: string, patch: TaskPatch): Task {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`Unknown Task "${taskId}".`);

    const logsPath = patch.logsPath ?? current.logsPath;
    const merged = TaskSchema.parse({
      ...current,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.jobId !== undefined ? { jobId: patch.jobId } : {}),
      ...(logsPath !== undefined ? { logsPath } : {}),
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      logsAvailable: this.logFileAvailable(logsPath ?? null),
      updatedAt: new Date().toISOString(),
    });

    this.db
      .prepare(
        `UPDATE tasks SET
           state = ?, job_id = ?, logs_path = ?, logs_available = ?, exit_code = ?,
           error = ?, started_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.state,
        merged.jobId ?? null,
        merged.logsPath ?? null,
        merged.logsAvailable ? 1 : 0,
        merged.exitCode ?? null,
        merged.error ?? null,
        merged.startedAt ?? null,
        merged.completedAt ?? null,
        merged.updatedAt,
        taskId,
      );

    return merged;
  }

  saveTaskOutputs(taskId: string, outputs: TaskOutputRecord[]): void {
    const result = this.db
      .prepare('UPDATE tasks SET outputs_json = ? WHERE id = ?')
      .run(JSON.stringify(outputs), taskId);
    if (Number(result.changes) === 0) {
      throw new Error(`Unknown Task "${taskId}".`);
    }
  }

  getTaskOutputs(taskId: string): TaskOutputRecord[] | undefined {
    const row = this.db
      .prepare('SELECT outputs_json FROM tasks WHERE id = ?')
      .get(taskId) as unknown as { outputs_json: string | null } | undefined;
    if (!row?.outputs_json) return undefined;

    try {
      const parsed = JSON.parse(row.outputs_json) as unknown;
      return Array.isArray(parsed) ? (parsed as TaskOutputRecord[]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Records one immutable managed output. Truth is content-addressed: the
   * (Run, Task attempt, name) identity can never be rewritten to different
   * bytes, and every Artifact stays inside its Task namespace.
   */
  recordArtifact(input: NewArtifactRecord): Artifact {
    requireNamespaceId(input.runId, 'Run');
    requireNamespaceId(input.taskId, 'Task');
    const namespacePath = this.taskNamespacePath(input.runId, input.taskId);
    if (
      !input.path.startsWith(`${namespacePath}/`) ||
      input.path.split('/').includes('..') ||
      isAbsolute(input.path)
    ) {
      throw new Error(`Artifact "${input.name}" must stay inside its Task namespace.`);
    }

    const existing = this.db
      .prepare(
        `SELECT id, run_id, task_id, node_id, name, media_type, path, sha256, size,
                schema_json, provenance_json, created_at
         FROM artifacts WHERE run_id = ? AND task_id = ? AND name = ?`,
      )
      .get(input.runId, input.taskId, input.name) as unknown as ArtifactRow | undefined;

    if (existing) {
      if (existing.path === input.path && existing.sha256 === input.sha256) {
        const parsed = this.rowToArtifact(existing);
        if (parsed) return parsed;
      }
      throw new Error(`Artifact "${input.name}" is immutable.`);
    }

    const artifact = ArtifactSchema.parse({ id: randomUUID(), ...input });
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, run_id, task_id, node_id, name, media_type, path, sha256, size,
           schema_json, provenance_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.taskId,
        artifact.nodeId,
        artifact.name,
        artifact.mediaType,
        artifact.path,
        artifact.sha256,
        artifact.size,
        artifact.schema ? JSON.stringify(artifact.schema) : null,
        JSON.stringify(artifact.provenance),
        artifact.createdAt,
      );

    return artifact;
  }

  /** Records one immutable typed Metric produced by a Task attempt. */
  recordMetric(input: NewMetricRecord): Metric {
    const existing = this.db
      .prepare('SELECT id FROM metrics WHERE run_id = ? AND task_id = ? AND metric_id = ?')
      .get(input.runId, input.taskId, input.metricId) as unknown as { id: string } | undefined;
    if (existing) {
      throw new Error(`Metric "${input.metricId}" is immutable.`);
    }

    const metric = MetricSchema.parse({ id: randomUUID(), ...input });
    this.db
      .prepare(
        `INSERT INTO metrics (
           id, run_id, task_id, node_id, metric_id, name, meaning, value_type, value_json,
           unit, scale_json, direction, schema_json, provenance_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.id,
        metric.runId,
        metric.taskId,
        metric.nodeId,
        metric.metricId,
        metric.name,
        metric.meaning,
        metric.valueType,
        JSON.stringify(metric.value),
        metric.unit ?? null,
        metric.scale ? JSON.stringify(metric.scale) : null,
        metric.direction ?? null,
        JSON.stringify(metric.schema),
        JSON.stringify(metric.provenance),
        metric.createdAt,
      );

    return metric;
  }

  /** Events are append-only: this method only ever inserts. */
  appendEvent(input: NewRunEvent): RunEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO events (run_id, task_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.taskId ?? null,
        input.type,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        createdAt,
      );

    return RunEventSchema.parse({
      id: Number(result.lastInsertRowid),
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      type: input.type,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdAt,
    });
  }

  listArtifacts(runId: string): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, task_id, node_id, name, media_type, path, sha256, size,
                schema_json, provenance_json, created_at
         FROM artifacts WHERE run_id = ? ORDER BY rowid ASC`,
      )
      .all(runId) as unknown as ArtifactRow[];

    return rows.flatMap((row) => {
      const artifact = this.rowToArtifact(row);
      return artifact ? [artifact] : [];
    });
  }

  listMetrics(runId: string): Metric[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, task_id, node_id, metric_id, name, meaning, value_type, value_json,
                unit, scale_json, direction, schema_json, provenance_json, created_at
         FROM metrics WHERE run_id = ? ORDER BY rowid ASC`,
      )
      .all(runId) as unknown as MetricRow[];

    return rows.flatMap((row) => {
      const metric = this.rowToMetric(row);
      return metric ? [metric] : [];
    });
  }

  listEvents(runId: string, after?: number): RunEvent[] {
    const rows = (
      after === undefined
        ? this.db
            .prepare(
              'SELECT id, run_id, task_id, type, payload_json, created_at FROM events WHERE run_id = ? ORDER BY id ASC',
            )
            .all(runId)
        : this.db
            .prepare(
              'SELECT id, run_id, task_id, type, payload_json, created_at FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC',
            )
            .all(runId, after)
    ) as unknown as EventRow[];

    return rows.flatMap((row) => {
      const event = this.rowToEvent(row);
      return event ? [event] : [];
    });
  }

  private rowToTask(row: TaskRow): Task | undefined {
    try {
      const parsed = TaskSchema.safeParse({
        id: row.id,
        runId: row.run_id,
        nodeId: row.node_id,
        label: row.label,
        manifestId: row.manifest_id,
        manifestVersion: row.manifest_version,
        attempt: row.attempt,
        state: row.state,
        ...(row.job_id ? { jobId: row.job_id } : {}),
        logsAvailable: this.logFileAvailable(row.logs_path),
        ...(row.logs_path ? { logsPath: row.logs_path } : {}),
        ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
        ...(row.error ? { error: row.error } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private rowToArtifact(row: ArtifactRow): Artifact | undefined {
    try {
      const parsed = ArtifactSchema.safeParse({
        id: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        nodeId: row.node_id,
        name: row.name,
        mediaType: row.media_type,
        path: row.path,
        sha256: row.sha256,
        size: row.size,
        ...(row.schema_json ? { schema: JSON.parse(row.schema_json) } : {}),
        provenance: JSON.parse(row.provenance_json),
        createdAt: row.created_at,
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private rowToMetric(row: MetricRow): Metric | undefined {
    try {
      const parsed = MetricSchema.safeParse({
        id: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        nodeId: row.node_id,
        metricId: row.metric_id,
        name: row.name,
        meaning: row.meaning,
        valueType: row.value_type,
        value: JSON.parse(row.value_json),
        ...(row.unit ? { unit: row.unit } : {}),
        ...(row.scale_json ? { scale: JSON.parse(row.scale_json) } : {}),
        ...(row.direction ? { direction: row.direction } : {}),
        schema: JSON.parse(row.schema_json),
        provenance: JSON.parse(row.provenance_json),
        createdAt: row.created_at,
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private rowToEvent(row: EventRow): RunEvent | undefined {
    try {
      const parsed = RunEventSchema.safeParse({
        id: row.id,
        runId: row.run_id,
        ...(row.task_id ? { taskId: row.task_id } : {}),
        type: row.type,
        ...(row.payload_json ? { payload: JSON.parse(row.payload_json) } : {}),
        createdAt: row.created_at,
      });
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private logFileAvailable(logsPath: string | null): boolean {
    if (!logsPath || isAbsolute(logsPath)) return false;
    const absolute = resolve(this.root, logsPath);
    const rel = relative(this.root, absolute);
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return false;
    }
    return existsSync(absolute);
  }

  /**
   * Project state is namespaced so two files with the same name never
   * overwrite one another:
   *
   * - Project: `<project>/...` (the user-owned filesystem)
   * - Run:     `<project>/.sflow/runs/<runId>/`
   * - Task:    `<project>/.sflow/runs/<runId>/tasks/<taskId>/`
   *
   * The path helpers are pure; the ensure helpers create the directories for
   * the Orchestrator and Compute Executor.
   */
  runNamespace(runId: string): string {
    return join(this.sflowDir, 'runs', requireNamespaceId(runId, 'Run'));
  }

  taskNamespace(runId: string, taskId: string): string {
    return join(
      this.runNamespace(runId),
      'tasks',
      requireNamespaceId(taskId, 'Task'),
    );
  }

  /** Project-relative Task namespace with forward slashes for persisted paths. */
  taskNamespacePath(runId: string, taskId: string): string {
    return `.sflow/runs/${requireNamespaceId(runId, 'Run')}/tasks/${requireNamespaceId(taskId, 'Task')}`;
  }

  ensureRunNamespace(runId: string): string {
    const directory = this.runNamespace(runId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  ensureTaskNamespace(runId: string, taskId: string): string {
    const directory = this.taskNamespace(runId, taskId);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private hashCredential(credential: string, salt: string): string {
    return scryptSync(credential, salt, SCRYPT_KEY_LENGTH).toString('hex');
  }

  private ensureProjectMetadata(): void {
    if (this.getSetting('project.id')) return;

    this.transaction(() => {
      this.setSetting('project.id', randomUUID());
      this.setSetting('project.name', basename(this.root) || 'Project');
      this.setSetting('project.createdAt', new Date().toISOString());
    });
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        layout_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_references (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        registered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        label TEXT NOT NULL,
        manifest_id TEXT NOT NULL,
        manifest_version TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        job_id TEXT,
        logs_path TEXT,
        logs_available INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        error TEXT,
        outputs_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        schema_json TEXT,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        metric_id TEXT NOT NULL,
        name TEXT NOT NULL,
        meaning TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT,
        scale_json TEXT,
        direction TEXT,
        schema_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS result_views (
        run_id TEXT PRIMARY KEY,
        ir_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_patches (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installed_nodes (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        path TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runs_workflow_id ON runs(workflow_id);
      CREATE INDEX IF NOT EXISTS tasks_run_id ON tasks(run_id);
      CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id);
    `);

    // Ticket #6 projects may already have the placeholder Task/Artifact/Metric
    // tables. Add the execution columns in place so upgrades keep Run history.
    this.ensureColumn('tasks', 'label', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('tasks', 'manifest_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('tasks', 'manifest_version', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('tasks', 'job_id', 'TEXT');
    this.ensureColumn('tasks', 'logs_available', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'exit_code', 'INTEGER');
    this.ensureColumn('tasks', 'error', 'TEXT');
    this.ensureColumn('tasks', 'outputs_json', 'TEXT');
    this.ensureColumn('tasks', 'created_at', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('tasks', 'started_at', 'TEXT');
    this.ensureColumn('tasks', 'completed_at', 'TEXT');

    this.ensureColumn('artifacts', 'node_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn(
      'artifacts',
      'media_type',
      "TEXT NOT NULL DEFAULT 'application/octet-stream'",
    );
    this.ensureColumn('artifacts', 'size', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('artifacts', 'schema_json', 'TEXT');

    this.ensureColumn('metrics', 'node_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('metrics', 'metric_id', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('metrics', 'meaning', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('metrics', 'value_type', "TEXT NOT NULL DEFAULT 'number'");
    this.ensureColumn('metrics', 'unit', 'TEXT');
    this.ensureColumn('metrics', 'scale_json', 'TEXT');
    this.ensureColumn('metrics', 'direction', 'TEXT');
    this.ensureColumn('metrics', 'schema_json', "TEXT NOT NULL DEFAULT '{}'");

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_run_node_attempt
        ON tasks(run_id, node_id, attempt);
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_task_name
        ON artifacts(run_id, task_id, name);
      CREATE UNIQUE INDEX IF NOT EXISTS metrics_task_metric
        ON metrics(run_id, task_id, metric_id);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
