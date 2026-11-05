import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SET_SCHEMA_REF,
  PREDICTED_STRUCTURE_SCHEMA_REF,
  ResultViewCompatibilityReportSchema,
  ResultViewIRSchema,
  buildDefaultResultView,
  validateResultViewBindings,
  type Artifact,
  type Metric,
  type Provenance,
  type Run,
  type Task,
  type WidgetDescriptor,
} from '@sflow/domain';

const now = '2026-01-02T03:04:05.000Z';

const candidateTableWidget: WidgetDescriptor = {
  id: 'sflow.candidate-table',
  version: '1.0.0',
  name: 'Candidate table',
  description: 'Renders CandidateSet candidates, ranks, and candidate-level scores.',
  acceptedArtifactSchemas: [CANDIDATE_SET_SCHEMA_REF],
  acceptedMetricSchemas: [],
  interactions: ['inspect', 'download', 'select-candidate'],
};

const metricSummaryWidget: WidgetDescriptor = {
  id: 'sflow.metric-summary',
  version: '1.0.0',
  name: 'Metric summary',
  description: 'Shows typed scientific Metrics with meaning, unit, and Provenance.',
  acceptedArtifactSchemas: [],
  acceptedMetricSchemas: [
    {
      namespace: 'sflow.binder.structure-prediction',
      name: 'meanPlddt',
      version: '1.0.0',
    },
  ],
  interactions: ['inspect', 'open-provenance'],
};

const structureViewerWidget: WidgetDescriptor = {
  id: 'sflow.structure-viewer',
  version: '1.0.0',
  name: 'Structure viewer',
  description: 'Inspects predicted structures.',
  acceptedArtifactSchemas: [PREDICTED_STRUCTURE_SCHEMA_REF],
  acceptedMetricSchemas: [],
  interactions: ['inspect', 'download'],
};

function makeProvenance(): Provenance {
  return {
    id: 'provenance-1',
    runId: 'run-1',
    taskId: 'task-generator',
    nodeId: 'node-generator',
    attempt: 1,
    manifestId: 'candidate-generation',
    manifestVersion: '1.0.0',
    inputs: { artifacts: [], fileReferences: [] },
    parameters: {},
    environment: { kind: 'container', image: 'ghcr.io/sflow/nodes/candidate-generation:1.0.0' },
    executor: { kind: 'local', jobId: 'job-1' },
    createdAt: now,
  };
}

function makeArtifact(overrides: Partial<Artifact> & Pick<Artifact, 'id' | 'name'>): Artifact {
  return {
    runId: 'run-1',
    taskId: 'task-generator',
    nodeId: 'node-generator',
    mediaType: 'application/json',
    path: `.sflow/runs/run-1/tasks/task-generator/${overrides.name}`,
    sha256: 'a'.repeat(64),
    size: 10,
    provenance: makeProvenance(),
    createdAt: now,
    ...overrides,
  };
}

function makeMetric(overrides: Partial<Metric> & Pick<Metric, 'id' | 'metricId' | 'schema'>): Metric {
  return {
    runId: 'run-1',
    taskId: 'task-generator',
    nodeId: 'node-generator',
    name: overrides.metricId,
    meaning: 'A typed scientific measurement.',
    valueType: 'number',
    value: 42,
    provenance: makeProvenance(),
    createdAt: now,
    ...overrides,
  };
}

function makeRun(): Run {
  return {
    id: 'run-1',
    workflowId: 'binder-design',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    snapshot: {
      version: 1,
      workflow: { version: 1, id: 'binder-design', name: 'Binder design', nodes: [], edges: [] },
      nodes: [],
    },
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'nodeId' | 'label'>): Task {
  return {
    runId: 'run-1',
    manifestId: 'candidate-generation',
    manifestVersion: '1.0.0',
    attempt: 1,
    state: 'completed',
    logsAvailable: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Result View IR', () => {
  it('describes a durable, log- and output-centered default view that is independent of frontend state', () => {
    const ir = buildDefaultResultView({
      runId: 'run-1',
      createdAt: now,
      widgets: [candidateTableWidget, metricSummaryWidget],
    });

    expect(ResultViewIRSchema.parse(ir)).toEqual(ir);
    expect(ir.version).toBe(1);
    expect(ir.runId).toBe('run-1');
    expect(ir.createdAt).toBe(now);

    // Logs and output files come first; specialized scientific blocks follow.
    expect(ir.blocks.map((block) => block.kind)).toEqual([
      'logs',
      'artifacts',
      'candidates',
      'metrics',
      'provenance',
      'widget',
      'widget',
    ]);
    expect(ir.blocks[0]).toMatchObject({ id: 'logs', title: 'Run and Task logs' });
    expect(ir.blocks[1]).toMatchObject({ id: 'artifacts', title: 'Output files' });
    expect(ir.blocks[2]).toMatchObject({
      kind: 'candidates',
      binding: { artifactSchemas: [CANDIDATE_SET_SCHEMA_REF] },
    });
    expect(ir.blocks[3]).toMatchObject({ kind: 'metrics' });
    expect(ir.blocks[4]).toMatchObject({ kind: 'provenance' });

    expect(ir.blocks[5]).toMatchObject({
      kind: 'widget',
      widgetId: 'sflow.candidate-table',
      title: 'Candidate table',
      binding: { artifactSchemas: [CANDIDATE_SET_SCHEMA_REF] },
    });
    expect(ir.blocks[6]).toMatchObject({
      kind: 'widget',
      widgetId: 'sflow.metric-summary',
      binding: {
        metricSchemas: [
          {
            namespace: 'sflow.binder.structure-prediction',
            name: 'meanPlddt',
            version: '1.0.0',
          },
        ],
      },
    });

    // The IR is a durable description, not a rendered frontend component.
    const serialized = JSON.stringify(ir);
    for (const frontendState of [
      'component',
      'props',
      'positions',
      'viewport',
      'selection',
      'layout',
    ]) {
      expect(serialized).not.toContain(frontendState);
    }
  });

  it('accepts compatible bindings, rejects incompatible or unknown widgets with a reason, and never coerces data', () => {
    const ir = buildDefaultResultView({
      runId: 'run-1',
      createdAt: now,
      widgets: [candidateTableWidget, metricSummaryWidget, structureViewerWidget],
    });

    ir.blocks.push(
      {
        id: 'widget-structure-viewer-incompatible',
        kind: 'widget',
        title: 'Structure viewer (incompatible binding)',
        widgetId: 'sflow.structure-viewer',
        binding: { artifactIds: ['artifact-candidates'] },
      },
      {
        id: 'widget-unregistered',
        kind: 'widget',
        title: 'Unregistered widget',
        widgetId: 'example.not-registered',
        binding: { artifactIds: ['artifact-candidates'] },
      },
    );

    const candidateArtifact = makeArtifact({
      id: 'artifact-candidates',
      name: 'candidates.json',
      schema: CANDIDATE_SET_SCHEMA_REF,
    });
    const structureArtifact = makeArtifact({
      id: 'artifact-structure',
      name: 'candidate-0001.pdb',
      mediaType: 'chemical/x-pdb',
      schema: PREDICTED_STRUCTURE_SCHEMA_REF,
    });
    const plddt = makeMetric({
      id: 'metric-plddt',
      metricId: 'meanPlddt',
      schema: {
        namespace: 'sflow.binder.structure-prediction',
        name: 'meanPlddt',
        version: '1.0.0',
      },
      unit: 'score',
    });
    // Same metric id, different namespaced meaning: it must never be merged
    // into the compatible Metric or fed to a widget that did not accept it.
    const foreignPlddt = makeMetric({
      id: 'metric-foreign-plddt',
      metricId: 'meanPlddt',
      meaning: 'A predictor-specific score with a different meaning.',
      schema: { namespace: 'custom.predictor', name: 'meanPlddt', version: '1.0.0' },
    });

    const report = validateResultViewBindings(
      ir,
      {
        run: makeRun(),
        tasks: [
          makeTask({ id: 'task-generator', nodeId: 'node-generator', label: 'Candidate generation' }),
        ],
        artifacts: [candidateArtifact, structureArtifact],
        metrics: [plddt, foreignPlddt],
      },
      [candidateTableWidget, metricSummaryWidget, structureViewerWidget],
    );
    expect(ResultViewCompatibilityReportSchema.parse(report)).toEqual(report);

    const evaluation = (blockId: string) =>
      report.blocks.find((block) => block.blockId === blockId)!;

    expect(evaluation('widget-sflow.candidate-table')).toMatchObject({
      status: 'compatible',
      artifactIds: ['artifact-candidates'],
      metricIds: [],
    });
    expect(evaluation('widget-sflow.structure-viewer')).toMatchObject({
      status: 'compatible',
      artifactIds: ['artifact-structure'],
    });
    expect(evaluation('widget-sflow.metric-summary')).toMatchObject({
      status: 'compatible',
      metricIds: ['metric-plddt'],
    });

    const incompatible = evaluation('widget-structure-viewer-incompatible');
    expect(incompatible.status).toBe('rejected');
    expect(incompatible.reason).toMatch(/schema/i);
    // The incompatible Artifact is never coerced into the Widget.
    expect(incompatible.artifactIds).toEqual([]);
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        {
          blockId: 'widget-structure-viewer-incompatible',
          widgetId: 'sflow.structure-viewer',
          reason: expect.stringContaining('predicted-structure'),
        },
        {
          blockId: 'widget-unregistered',
          widgetId: 'example.not-registered',
          reason: expect.stringContaining('not registered'),
        },
      ]),
    );

    // The metrics block binds both typed records without merging their
    // meanings; grouping happens by namespaced schema identity.
    expect(evaluation('metrics').metricIds).toEqual([
      'metric-plddt',
      'metric-foreign-plddt',
    ]);
  });
});
