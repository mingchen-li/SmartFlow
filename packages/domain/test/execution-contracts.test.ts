import { describe, expect, it } from 'vitest';
import {
  ArtifactSchema,
  CandidateSchema,
  CandidateSetSchema,
  MetricSchema,
  NodeExecutionError,
  ProvenanceSchema,
  RunDetailResponseSchema,
  shouldRetryTask,
  TaskSchema,
  TASK_STATES,
  type Artifact,
  type Metric,
  type Provenance,
  type RetryPolicy,
  type Run,
  type Task,
} from '@sflow/domain';

const now = '2026-01-02T03:04:05.000Z';

function makeProvenance(): Provenance {
  return {
    id: 'provenance-1',
    runId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-generator',
    attempt: 1,
    manifestId: 'candidate-generation',
    manifestVersion: '1.0.0',
    inputs: {
      artifacts: [],
      fileReferences: [
        {
          parameterId: 'targetFile',
          fileReferenceId: 'file-1',
          path: 'target.pdb',
          name: 'target.pdb',
        },
      ],
    },
    parameters: { seed: 42, numCandidates: 8 },
    environment: {
      kind: 'container',
      image: 'ghcr.io/sflow/nodes/candidate-generation:1.0.0',
    },
    executor: { kind: 'local', jobId: 'job-1' },
    createdAt: now,
  };
}

function makeArtifact(provenance: Provenance): Artifact {
  return {
    id: 'artifact-1',
    runId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-generator',
    name: 'candidates.json',
    mediaType: 'application/json',
    path: '.sflow/runs/run-1/tasks/task-1/candidates.json',
    sha256: 'a'.repeat(64),
    size: 1234,
    schema: { namespace: 'sflow.binder', name: 'candidate-set', version: '1.0.0' },
    provenance,
    createdAt: now,
  };
}

function makeMetric(provenance: Provenance): Metric {
  return {
    id: 'metric-1',
    runId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-generator',
    metricId: 'candidateCount',
    name: 'Candidate count',
    meaning: 'Number of candidates produced by generation.',
    valueType: 'number',
    value: 8,
    scale: { min: 0 },
    direction: 'neutral',
    schema: { namespace: 'sflow.binder.candidate-generation', name: 'candidateCount', version: '1.0.0' },
    provenance,
    createdAt: now,
  };
}

const run: Run = {
  id: 'run-1',
  workflowId: 'binder-design',
  status: 'completed',
  createdAt: now,
  updatedAt: now,
  snapshot: { version: 1, workflow: { version: 1, nodes: [], edges: [] }, nodes: [] },
};

const task: Task = {
  id: 'task-1',
  runId: 'run-1',
  nodeId: 'node-generator',
  label: 'Candidate generation',
  manifestId: 'candidate-generation',
  manifestVersion: '1.0.0',
  attempt: 1,
  state: 'completed',
  jobId: 'job-1',
  logsAvailable: true,
  logsPath: '.sflow/runs/run-1/tasks/task-1/logs.txt',
  exitCode: 0,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: now,
};

describe('execution domain contracts', () => {
  it('uses exactly the five Task states and one attempt per atomic execution', () => {
    expect(TASK_STATES).toEqual(['queued', 'running', 'completed', 'failed', 'canceled']);
    expect(TaskSchema.parse(task)).toEqual(task);
    expect(TaskSchema.safeParse({ ...task, attempt: 0 }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, state: 'awaiting-rerun' }).success).toBe(false);
  });

  it('describes Artifacts with content identity, media type, size, and namespace path', () => {
    const artifact = makeArtifact(makeProvenance());
    expect(ArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(ArtifactSchema.safeParse({ ...artifact, sha256: 'not-a-digest' }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...artifact, size: -1 }).success).toBe(false);
  });

  it('links Metrics to a namespaced, versioned schema, meaning, scale, and Provenance', () => {
    const metric = makeMetric(makeProvenance());
    expect(MetricSchema.parse(metric)).toEqual(metric);
    // The value must agree with its declared value type.
    expect(MetricSchema.safeParse({ ...metric, value: 'eight' }).success).toBe(false);
    // Different metric meanings are never merged implicitly: identity is the
    // namespaced schema, not the display name.
    expect(metric.schema).toEqual({
      namespace: 'sflow.binder.candidate-generation',
      name: 'candidateCount',
      version: '1.0.0',
    });
  });

  it('links Provenance to the Run, Task attempt, Manifest version, inputs, parameters, and environment', () => {
    const provenance = makeProvenance();
    expect(ProvenanceSchema.parse(provenance)).toEqual(provenance);
    expect(provenance.attempt).toBe(1);
    expect(provenance.manifestVersion).toBe('1.0.0');
    expect(provenance.inputs.fileReferences[0].path).toBe('target.pdb');
    expect(provenance.environment.image).toContain('candidate-generation');
  });

  it('types Candidates and CandidateSets with deterministic generation context and scores', () => {
    const candidateSet = {
      id: 'candidate-set:seed-42',
      name: 'Generated candidates',
      candidates: [
        {
          id: 'candidate-0001',
          sequence: 'QVQLVESGGGLVQAGGSLR',
          generation: 'generated' as const,
        },
        {
          id: 'candidate-0002',
          sequence: 'QVQLVESGGGLVQAGGSLK',
          generation: 'designed' as const,
          parentId: 'candidate-0001',
        },
      ],
      scores: [
        { candidateId: 'candidate-0001', metricId: 'plddt', value: 82.5 },
      ],
      context: { strategy: 'cdr-focused', seed: 42, model: 'vhh-designer-v1' },
    };

    expect(CandidateSetSchema.parse(candidateSet)).toEqual(candidateSet);
    expect(CandidateSchema.safeParse({ id: 'candidate-1' }).success).toBe(false);
    expect(
      CandidateSetSchema.safeParse({ ...candidateSet, context: { strategy: 7 } }).success,
    ).toBe(false);
  });

  it('describes an observable Run with tasks, artifacts, and metrics', () => {
    const provenance = makeProvenance();
    const detail = {
      run,
      tasks: [task],
      artifacts: [makeArtifact(provenance)],
      metrics: [makeMetric(provenance)],
    };

    expect(RunDetailResponseSchema.parse(detail)).toEqual(detail);
    expect(
      RunDetailResponseSchema.safeParse({ ...detail, tasks: [{ ...task, attempt: -2 }] }).success,
    ).toBe(false);
  });

  it('retries only Manifest-declared retryable failures within the attempt limit', () => {
    const transient: RetryPolicy = {
      maxAttempts: 2,
      backoffSeconds: 30,
      retryOn: ['transient', 'exit-code'],
    };

    // The first attempt may be retried; the last declared attempt may not.
    expect(shouldRetryTask(transient, 1, 'transient')).toBe(true);
    expect(shouldRetryTask(transient, 1, 'exit-code')).toBe(true);
    expect(shouldRetryTask(transient, 2, 'transient')).toBe(false);
    expect(shouldRetryTask({ ...transient, maxAttempts: 1 }, 1, 'transient')).toBe(false);

    // Only kinds declared by the policy are retryable.
    expect(shouldRetryTask(transient, 1, 'timeout')).toBe(false);
    expect(
      shouldRetryTask({ ...transient, retryOn: ['timeout'] }, 1, 'timeout'),
    ).toBe(true);

    // Parameter and validation errors are never retried, even if a policy
    // accidentally lists every retryable kind.
    for (const kind of ['parameter', 'validation', 'unknown'] as const) {
      expect(
        shouldRetryTask(
          { maxAttempts: 5, backoffSeconds: 0, retryOn: ['transient', 'timeout', 'exit-code'] },
          1,
          kind,
        ),
      ).toBe(false);
    }
  });

  it('classifies Node failures so parameter errors are distinguishable from transient failures', () => {
    const parameter = new NodeExecutionError('parameter', 'Parameter "seed" must be an integer.');
    expect(parameter).toBeInstanceOf(Error);
    expect(parameter.message).toBe('Parameter "seed" must be an integer.');
    expect(parameter.failureKind).toBe('parameter');

    const transient = new NodeExecutionError('transient', 'The scheduler connection dropped.');
    expect(transient.failureKind).toBe('transient');

    expect(shouldRetryTask({ maxAttempts: 2, backoffSeconds: 0, retryOn: ['transient'] }, 1, parameter.failureKind)).toBe(false);
    expect(shouldRetryTask({ maxAttempts: 2, backoffSeconds: 0, retryOn: ['transient'] }, 1, transient.failureKind)).toBe(true);
  });

  it('exposes the failure classification and retry history on a Task attempt', () => {
    const failed = {
      ...task,
      attempt: 1,
      state: 'failed' as const,
      failureKind: 'transient' as const,
      exitCode: 1,
      error: 'The scheduler connection dropped.',
    };
    expect(TaskSchema.parse(failed)).toEqual(failed);
    expect(TaskSchema.safeParse({ ...failed, failureKind: 'meteor' }).success).toBe(false);

    const awaitingRetry = {
      ...task,
      id: 'task-2',
      attempt: 2,
      state: 'queued' as const,
      jobId: undefined,
      logsAvailable: false,
      logsPath: undefined,
      exitCode: undefined,
      completedAt: undefined,
      startedAt: undefined,
    };
    expect(TaskSchema.parse(awaitingRetry)).toMatchObject({ attempt: 2, state: 'queued' });
  });
});
