import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunSnapshot,
  defaultParameters,
  type Artifact,
  type Metric,
  type NodeManifest,
  type Run,
  type RunEvent,
  type RunFileReference,
  type RunStatus,
  type Task,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinManifests, createBuiltinNodeRegistry } from '@sflow/nodes';
import {
  LocalExecutor,
  Orchestrator,
  type NewArtifactRecord,
  type NewMetricRecord,
  type NewRunEvent,
  type NewTask,
  type OrchestratorStore,
  type TaskOutputRecord,
  type TaskPatch,
} from '@sflow/orchestrator';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function manifest(id: string): NodeManifest {
  const found = builtinManifests.find((item) => item.id === id);
  if (!found) throw new Error(`Missing Manifest ${id}`);
  return found;
}

/**
 * In-memory implementation of the Orchestrator persistence seam. It records
 * the same observable facts as the SQLite ProjectStore without coupling this
 * package to the Server.
 */
class MemoryOrchestratorStore implements OrchestratorStore {
  readonly runs = new Map<string, Run>();
  readonly tasks = new Map<string, Task>();
  readonly artifacts: Artifact[] = [];
  readonly metrics: Metric[] = [];
  readonly events: RunEvent[] = [];
  readonly outputs = new Map<string, TaskOutputRecord[]>();
  private taskOrder: string[] = [];
  private taskCounter = 0;
  private eventCounter = 0;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  seedRun(run: Run): void {
    this.runs.set(run.id, run);
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown Run ${runId}`);
    this.runs.set(runId, { ...run, status, updatedAt: new Date().toISOString() });
  }

  listTasks(runId: string): Task[] {
    return this.taskOrder
      .map((id) => this.tasks.get(id)!)
      .filter((task) => task.runId === runId);
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  createTask(input: NewTask): Task {
    this.taskCounter += 1;
    const id = input.id ?? `task-${this.taskCounter}`;
    const now = input.createdAt ?? new Date().toISOString();
    const task: Task = {
      id,
      runId: input.runId,
      nodeId: input.nodeId,
      label: input.label,
      manifestId: input.manifestId,
      manifestVersion: input.manifestVersion,
      attempt: input.attempt,
      state: input.state,
      logsAvailable: false,
      ...(input.logsPath ? { logsPath: input.logsPath } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.taskOrder.push(id);
    return task;
  }

  updateTask(taskId: string, patch: TaskPatch): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown Task ${taskId}`);
    const logsPath = patch.logsPath ?? task.logsPath;
    const logsAvailable = logsPath
      ? existsSync(join(this.projectRoot, logsPath))
      : task.logsAvailable;
    const updated: Task = {
      ...task,
      ...patch,
      logsAvailable,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  saveTaskOutputs(taskId: string, outputs: TaskOutputRecord[]): void {
    this.outputs.set(taskId, structuredClone(outputs));
  }

  getTaskOutputs(taskId: string): TaskOutputRecord[] | undefined {
    return this.outputs.get(taskId);
  }

  recordArtifact(input: NewArtifactRecord): Artifact {
    const existing = this.artifacts.find(
      (artifact) =>
        artifact.runId === input.runId &&
        artifact.taskId === input.taskId &&
        artifact.name === input.name,
    );
    if (existing) {
      if (existing.sha256 !== input.sha256) {
        throw new Error(`Artifact "${input.name}" is immutable.`);
      }
      return existing;
    }
    const artifact: Artifact = {
      id: `artifact-${this.artifacts.length + 1}`,
      ...input,
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  recordMetric(input: NewMetricRecord): Metric {
    const metric: Metric = { id: `metric-${this.metrics.length + 1}`, ...input };
    this.metrics.push(metric);
    return metric;
  }

  appendEvent(input: NewRunEvent): RunEvent {
    this.eventCounter += 1;
    const event: RunEvent = {
      id: this.eventCounter,
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      type: input.type,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  runNamespace(runId: string): string {
    return join(this.projectRoot, '.sflow', 'runs', runId);
  }

  taskNamespace(runId: string, taskId: string): string {
    return join(this.runNamespace(runId), 'tasks', taskId);
  }

  taskNamespacePath(runId: string, taskId: string): string {
    return `.sflow/runs/${runId}/tasks/${taskId}`;
  }
}

interface Fixture {
  projectRoot: string;
  workflow: WorkflowIR;
  snapshot: Run['snapshot'];
}

const NODE_IDS = {
  target: 'node-target',
  generator: 'node-generator',
  designer: 'node-designer',
  predictor: 'node-predictor',
  comparison: 'node-comparison',
};

function binderFixture(options: { includeTargetFile?: boolean } = {}): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sflow-orchestrator-'));
  roots.push(projectRoot);
  if (options.includeTargetFile !== false) {
    writeFileSync(
      join(projectRoot, 'target.pdb'),
      [
        'HEADER TARGET',
        'ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N',
        'ATOM      2  CA  ALA A   1      12.560   6.134  -6.504  1.00  0.00           C',
        'ATOM      3  N   GLY A   2      13.104   7.134  -6.504  1.00  0.00           N',
        'END',
      ].join('\n'),
    );
  }

  const fileReference: RunFileReference = {
    parameterId: 'targetFile',
    fileReferenceId: 'file-1',
    path: 'target.pdb',
    name: 'target.pdb',
  };

  const params = (id: string): Record<string, unknown> => {
    const defaults = defaultParameters(manifest(id));
    switch (id) {
      case 'target-input':
        return {
          ...defaults,
          targetFile: {
            fileReferenceId: fileReference.fileReferenceId,
            path: fileReference.path,
            name: fileReference.name,
          },
        };
      case 'candidate-generation':
        return { ...defaults, numCandidates: 5, seed: 42, strategy: 'cdr-focused' };
      case 'sequence-design':
        return { ...defaults, numDesigns: 3, randomSeed: 7 };
      case 'structure-prediction':
        return { ...defaults, seed: 1 };
      case 'candidate-comparison':
        return { ...defaults, topN: 2, label: 'round-1' };
      default:
        return defaults;
    }
  };

  const nodes: WorkflowIR['nodes'] = [
    ['target', 'target-input'],
    ['generator', 'candidate-generation'],
    ['designer', 'sequence-design'],
    ['predictor', 'structure-prediction'],
    ['comparison', 'candidate-comparison'],
  ].map(([key, manifestId]) => ({
    id: NODE_IDS[key as keyof typeof NODE_IDS],
    manifestId,
    manifestVersion: '1.0.0',
    label: manifest(manifestId).name,
    parameters: params(manifestId),
    resources: {},
  }));

  const connect = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ): WorkflowIR['edges'][number] => ({ id, source, sourcePort, target, targetPort });

  const workflow: WorkflowIR = {
    version: 1,
    id: 'binder-design',
    name: 'Binder design',
    nodes,
    edges: [
      connect('e-target-data', NODE_IDS.target, 'target', NODE_IDS.generator, 'target'),
      connect(
        'e-target-control',
        NODE_IDS.target,
        'control-out',
        NODE_IDS.generator,
        'control-in',
      ),
      connect(
        'e-generator-data',
        NODE_IDS.generator,
        'candidates',
        NODE_IDS.designer,
        'candidates',
      ),
      connect(
        'e-generator-control',
        NODE_IDS.generator,
        'control-out',
        NODE_IDS.designer,
        'control-in',
      ),
      connect(
        'e-designer-data',
        NODE_IDS.designer,
        'designs',
        NODE_IDS.predictor,
        'designs',
      ),
      connect(
        'e-designer-control',
        NODE_IDS.designer,
        'control-out',
        NODE_IDS.predictor,
        'control-in',
      ),
      connect(
        'e-predictor-data',
        NODE_IDS.predictor,
        'scored',
        NODE_IDS.comparison,
        'scored',
      ),
      connect(
        'e-predictor-control',
        NODE_IDS.predictor,
        'control-out',
        NODE_IDS.comparison,
        'control-in',
      ),
    ],
  };

  return {
    projectRoot,
    workflow,
    snapshot: createRunSnapshot(workflow, builtinManifests),
  };
}

function queuedRun(snapshot: Run['snapshot'], id = 'run-1'): Run {
  return {
    id,
    workflowId: 'binder-design',
    status: 'queued',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    snapshot,
  };
}

function makeOrchestrator(fixture: Fixture, store: MemoryOrchestratorStore): Orchestrator {
  const executor = new LocalExecutor({
    projectRoot: fixture.projectRoot,
    jobsDir: join(fixture.projectRoot, '.sflow', 'executor'),
    registry: createBuiltinNodeRegistry(),
  });
  return new Orchestrator({ store, executor, pollIntervalMs: 2 });
}

describe('Orchestrator dependency scheduling and persisted execution', () => {
  it('schedules one Task per atomic Node in dependency order and completes the Run', async () => {
    const fixture = binderFixture();
    const store = new MemoryOrchestratorStore(fixture.projectRoot);
    const run = queuedRun(fixture.snapshot);
    store.seedRun(run);
    const orchestrator = makeOrchestrator(fixture, store);

    await orchestrator.run(run.id);

    expect(store.getRun(run.id)?.status).toBe('completed');
    const tasks = store.listTasks(run.id);
    expect(tasks).toHaveLength(5);
    expect(tasks.map((task) => task.nodeId)).toEqual([
      NODE_IDS.target,
      NODE_IDS.generator,
      NODE_IDS.designer,
      NODE_IDS.predictor,
      NODE_IDS.comparison,
    ]);
    for (const task of tasks) {
      expect(task.attempt).toBe(1);
      expect(task.state).toBe('completed');
      expect(task.logsAvailable).toBe(true);
      expect(task.exitCode).toBe(0);
      expect(readFileSync(join(fixture.projectRoot, task.logsPath!), 'utf8')).toContain(
        `node=${task.manifestId} attempt=1`,
      );
    }

    // Every edge dependency finished before its target started.
    const eventIndex = (taskId: string, type: RunEvent['type']): number =>
      store.events.findIndex((event) => event.taskId === taskId && event.type === type);
    const taskByNode = new Map(tasks.map((task) => [task.nodeId, task]));
    for (const edge of fixture.workflow.edges) {
      const source = taskByNode.get(edge.source)!;
      const target = taskByNode.get(edge.target)!;
      expect(eventIndex(source.id, 'task.completed')).toBeGreaterThanOrEqual(0);
      expect(eventIndex(source.id, 'task.completed')).toBeLessThan(
        eventIndex(target.id, 'task.running'),
      );
    }

    // Run-level state transitions are persisted as events.
    const runEventTypes = store.events
      .filter((event) => event.taskId === undefined)
      .map((event) => event.type);
    expect(runEventTypes).toEqual(['run.started', 'run.completed']);
  });

  it('records content-addressed Artifacts and typed Metrics with Provenance', async () => {
    const fixture = binderFixture();
    const store = new MemoryOrchestratorStore(fixture.projectRoot);
    const run = queuedRun(fixture.snapshot);
    store.seedRun(run);
    const orchestrator = makeOrchestrator(fixture, store);

    await orchestrator.run(run.id);

    expect(store.artifacts.length).toBeGreaterThan(10);
    for (const artifact of store.artifacts) {
      const absolute = join(fixture.projectRoot, artifact.path);
      expect(existsSync(absolute)).toBe(true);
      const bytes = readFileSync(absolute);
      expect(artifact.size).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(artifact.path.startsWith(`.sflow/runs/${run.id}/tasks/`)).toBe(true);
      expect(artifact.provenance).toMatchObject({
        runId: run.id,
        taskId: artifact.taskId,
        nodeId: artifact.nodeId,
        attempt: 1,
        executor: { kind: 'local' },
      });
    }

    // Same-named Artifacts are unique per Task attempt and content identity.
    const keys = store.artifacts.map(
      (artifact) => `${artifact.taskId}:${artifact.name}:${artifact.sha256}`,
    );
    expect(new Set(keys).size).toBe(keys.length);

    const meanPlddt = store.metrics.find((metric) => metric.metricId === 'meanPlddt');
    expect(meanPlddt).toBeDefined();
    expect(meanPlddt).toMatchObject({
      runId: run.id,
      nodeId: NODE_IDS.predictor,
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 100 },
      direction: 'higher-is-better',
      schema: {
        namespace: 'sflow.binder.structure-prediction',
        name: 'meanPlddt',
        version: '1.0.0',
      },
      provenance: {
        manifestId: 'structure-prediction',
        manifestVersion: '1.0.0',
        environment: {
          kind: 'container',
          image: 'ghcr.io/sflow/nodes/structure-prediction:1.0.0',
        },
        executor: { kind: 'local', jobId: expect.any(String) },
      },
    });
    expect(meanPlddt?.provenance.parameters).toMatchObject({ predictor: 'esmfold2', seed: 1 });

    // Target provenance links its path-backed input.
    const targetArtifact = store.artifacts.find(
      (artifact) => artifact.nodeId === NODE_IDS.target && artifact.name === 'target.json',
    );
    expect(targetArtifact?.provenance.inputs.fileReferences).toEqual([
      expect.objectContaining({ parameterId: 'targetFile', path: 'target.pdb' }),
    ]);

    // Downstream provenance links upstream Artifact ids.
    const report = store.artifacts.find((artifact) => artifact.name === 'report.json');
    expect(report?.provenance.inputs.artifacts.length).toBeGreaterThan(0);
  });

  it('executes only the immutable Run snapshot and produces deterministic outputs', async () => {
    const fixture = binderFixture();
    const store = new MemoryOrchestratorStore(fixture.projectRoot);
    const first = queuedRun(fixture.snapshot, 'run-1');
    const second = queuedRun(fixture.snapshot, 'run-2');
    store.seedRun(first);
    store.seedRun(second);
    const orchestrator = makeOrchestrator(fixture, store);

    await orchestrator.run(first.id);
    await orchestrator.run(second.id);

    // The snapshot parameter (5 candidates) governed execution.
    const firstGenerationTask = store
      .listTasks(first.id)
      .find((task) => task.nodeId === NODE_IDS.generator)!;
    const candidates = store
      .getTaskOutputs(firstGenerationTask.id)!
      .find((output) => output.portId === 'candidates');
    expect((candidates?.value as { candidates: unknown[] }).candidates).toHaveLength(5);

    const digests = (runId: string): string[] =>
      store.artifacts
        .filter((artifact) => artifact.runId === runId)
        .map((artifact) => `${artifact.nodeId}/${artifact.name}:${artifact.sha256}`)
        .sort();
    expect(digests(first.id)).toEqual(digests(second.id));
    expect(digests(first.id).length).toBeGreaterThan(10);
  });

  it('persists a failed Task and failed Run while leaving downstream Tasks queued', async () => {
    const fixture = binderFixture({ includeTargetFile: false });
    const store = new MemoryOrchestratorStore(fixture.projectRoot);
    const run = queuedRun(fixture.snapshot);
    store.seedRun(run);
    const orchestrator = makeOrchestrator(fixture, store);

    await orchestrator.run(run.id);

    expect(store.getRun(run.id)?.status).toBe('failed');
    const tasks = store.listTasks(run.id);
    const target = tasks.find((task) => task.nodeId === NODE_IDS.target)!;
    expect(target.state).toBe('failed');
    expect(target.exitCode).toBe(1);
    expect(target.error).toContain('target.pdb');
    expect(
      tasks
        .filter((task) => task.nodeId !== NODE_IDS.target)
        .map((task) => task.state),
    ).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'run.started',
        'task.queued',
        'task.running',
        'task.failed',
        'run.failed',
      ]),
    );
    expect(store.artifacts).toHaveLength(0);
  });

  it('can be observed while running and settles when idle', async () => {
    const fixture = binderFixture();
    const store = new MemoryOrchestratorStore(fixture.projectRoot);
    const run = queuedRun(fixture.snapshot);
    store.seedRun(run);
    const orchestrator = makeOrchestrator(fixture, store);

    orchestrator.start(run.id);
    expect(store.getRun(run.id)?.status).toBe('running');

    await orchestrator.whenIdle(run.id);
    expect(store.getRun(run.id)?.status).toBe('completed');
    expect(store.listTasks(run.id).every((task) => task.state === 'completed')).toBe(true);
  });
});
