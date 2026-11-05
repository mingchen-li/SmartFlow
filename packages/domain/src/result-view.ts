import { z } from 'zod';
import { ArtifactSchema, MetricSchema, SchemaRefSchema, TaskSchema } from './execution';
import { RunSchema } from './run';
import type { Artifact, Metric, SchemaRef, Task } from './execution';

/**
 * Result View contracts (ticket #8).
 *
 * Result View IR is the durable, schema-bound description of a Run's analysis
 * page. It names ordered blocks and their data bindings but contains no
 * frontend component code, layout geometry, or transient render state. Widgets
 * declare the Artifact and Metric schemas they accept and the interactions they
 * support; bindings are validated before anything renders (ADR-0006).
 */

export const RESULT_VIEW_IR_VERSION = 1;

/** Binder schema identities this slice can interpret. */
export const CANDIDATE_SET_SCHEMA_REF: SchemaRef = {
  namespace: 'sflow.binder',
  name: 'candidate-set',
  version: '1.0.0',
};
export const COMPARISON_REPORT_SCHEMA_REF: SchemaRef = {
  namespace: 'sflow.binder',
  name: 'comparison-report',
  version: '1.0.0',
};
export const PREDICTED_STRUCTURE_SCHEMA_REF: SchemaRef = {
  namespace: 'sflow.binder',
  name: 'predicted-structure',
  version: '1.0.0',
};
export const TARGET_STRUCTURE_SCHEMA_REF: SchemaRef = {
  namespace: 'sflow.binder',
  name: 'target-structure',
  version: '1.0.0',
};

export const ResultViewBlockKindSchema = z.enum([
  'logs',
  'artifacts',
  'candidates',
  'metrics',
  'provenance',
  'widget',
]);
export type ResultViewBlockKind = z.infer<typeof ResultViewBlockKindSchema>;

export const WidgetInteractionSchema = z.enum([
  'download',
  'inspect',
  'select-candidate',
  'filter',
  'open-provenance',
]);
export type WidgetInteraction = z.infer<typeof WidgetInteractionSchema>;

/**
 * A registered Widget. The declaration is data: the registry is what a Results
 * Agent or a future extension composes against. It never carries component
 * code or an untyped render target.
 */
export const WidgetDescriptorSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    acceptedArtifactSchemas: z.array(SchemaRefSchema),
    acceptedMetricSchemas: z.array(SchemaRefSchema),
    interactions: z.array(WidgetInteractionSchema).min(1),
  })
  .superRefine((widget, context) => {
    if (
      widget.acceptedArtifactSchemas.length === 0 &&
      widget.acceptedMetricSchemas.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedArtifactSchemas'],
        message: 'A Widget must accept at least one Artifact or Metric schema.',
      });
    }
  });
export type WidgetDescriptor = z.infer<typeof WidgetDescriptorSchema>;

/**
 * A schema-bound binding. Explicit ids are strict references; schema selectors
 * filter Run data by exact namespaced schema identity. Scientific values are
 * never matched by name alone, so incompatible meanings cannot be merged.
 */
export const ResultViewBindingSchema = z.strictObject({
  artifactIds: z.array(z.string().min(1)).optional(),
  metricIds: z.array(z.string().min(1)).optional(),
  taskIds: z.array(z.string().min(1)).optional(),
  artifactSchemas: z.array(SchemaRefSchema).optional(),
  metricSchemas: z.array(SchemaRefSchema).optional(),
});
export type ResultViewBinding = z.infer<typeof ResultViewBindingSchema>;

const blockBase = {
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  binding: ResultViewBindingSchema,
};

export const LogsBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('logs'),
});
export const ArtifactsBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('artifacts'),
});
export const CandidatesBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('candidates'),
});
export const MetricsBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('metrics'),
});
export const ProvenanceBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('provenance'),
});
export const WidgetBlockSchema = z.strictObject({
  ...blockBase,
  kind: z.literal('widget'),
  widgetId: z.string().min(1).max(200),
});

export const ResultViewBlockSchema = z.discriminatedUnion('kind', [
  LogsBlockSchema,
  ArtifactsBlockSchema,
  CandidatesBlockSchema,
  MetricsBlockSchema,
  ProvenanceBlockSchema,
  WidgetBlockSchema,
]);
export type ResultViewBlock = z.infer<typeof ResultViewBlockSchema>;

export const ResultViewIRSchema = z.strictObject({
  version: z.number().int().positive(),
  id: z.string().min(1).max(300),
  runId: z.string().min(1).max(300),
  createdAt: z.string().min(1),
  blocks: z.array(ResultViewBlockSchema).min(1),
});
export type ResultViewIR = z.infer<typeof ResultViewIRSchema>;

export const WidgetCatalogResponseSchema = z.strictObject({
  widgets: z.array(WidgetDescriptorSchema),
});
export type WidgetCatalogResponse = z.infer<typeof WidgetCatalogResponseSchema>;

/** Stable identity for a namespaced, versioned scientific schema. */
export function schemaKey(schema: SchemaRef): string {
  return `${schema.namespace}/${schema.name}@${schema.version}`;
}

export interface BuildDefaultResultViewInput {
  runId: string;
  createdAt: string;
  widgets: readonly WidgetDescriptor[];
}

/**
 * The default Result View for any Run. Logs and output files always lead, so a
 * Run stays inspectable even when no specialized visualization applies. The
 * same builder is used for every Run, so the page is durable and independent
 * of any frontend bundle.
 */
export function buildDefaultResultView(input: BuildDefaultResultViewInput): ResultViewIR {
  const widgetBlocks: ResultViewBlock[] = input.widgets.map((widget) => ({
    id: `widget-${widget.id}`,
    kind: 'widget',
    title: widget.name,
    description: widget.description,
    widgetId: widget.id,
    binding: {
      ...(widget.acceptedArtifactSchemas.length > 0
        ? { artifactSchemas: structuredClone(widget.acceptedArtifactSchemas) }
        : {}),
      ...(widget.acceptedMetricSchemas.length > 0
        ? { metricSchemas: structuredClone(widget.acceptedMetricSchemas) }
        : {}),
    },
  }));

  return {
    version: RESULT_VIEW_IR_VERSION,
    id: `result-view-${input.runId}`,
    runId: input.runId,
    createdAt: input.createdAt,
    blocks: [
      {
        id: 'logs',
        kind: 'logs',
        title: 'Run and Task logs',
        binding: {},
      },
      {
        id: 'artifacts',
        kind: 'artifacts',
        title: 'Output files',
        binding: {},
      },
      {
        id: 'candidates',
        kind: 'candidates',
        title: 'Candidates',
        binding: { artifactSchemas: [CANDIDATE_SET_SCHEMA_REF] },
      },
      {
        id: 'metrics',
        kind: 'metrics',
        title: 'Metrics',
        binding: {},
      },
      {
        id: 'provenance',
        kind: 'provenance',
        title: 'Provenance',
        binding: {},
      },
      ...widgetBlocks,
    ],
  };
}

/** Data available to a Result View render. */
export interface ResultViewData {
  run: z.infer<typeof RunSchema>;
  tasks: readonly Task[];
  artifacts: readonly Artifact[];
  metrics: readonly Metric[];
}

export const ResultViewDataSchema = z.strictObject({
  run: RunSchema,
  tasks: z.array(TaskSchema),
  artifacts: z.array(ArtifactSchema),
  metrics: z.array(MetricSchema),
});

export const ResultViewBlockStatusSchema = z.enum(['compatible', 'empty', 'rejected']);
export type ResultViewBlockStatus = z.infer<typeof ResultViewBlockStatusSchema>;

/**
 * The resolved state of one block. `compatible` blocks render with exactly the
 * listed ids; `empty` blocks show their empty state; `rejected` blocks are
 * omitted with a reason. A rejected block never carries coerced data.
 */
export const ResultViewBlockEvaluationSchema = z.strictObject({
  blockId: z.string().min(1),
  kind: ResultViewBlockKindSchema,
  status: ResultViewBlockStatusSchema,
  widgetId: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)),
  metricIds: z.array(z.string().min(1)),
  taskIds: z.array(z.string().min(1)),
});
export type ResultViewBlockEvaluation = z.infer<typeof ResultViewBlockEvaluationSchema>;

export const ResultViewCompatibilityReportSchema = z.strictObject({
  accepted: z.array(z.string().min(1)),
  empty: z.array(z.string().min(1)),
  rejected: z.array(
    z.strictObject({
      blockId: z.string().min(1),
      widgetId: z.string().min(1).optional(),
      reason: z.string().min(1),
    }),
  ),
  blocks: z.array(ResultViewBlockEvaluationSchema),
});
export type ResultViewCompatibilityReport = z.infer<
  typeof ResultViewCompatibilityReportSchema
>;

function unique(value: readonly string[]): string[] {
  return [...new Set(value)];
}

function findArtifactSchema(
  data: ResultViewData,
  artifactId: string,
): Artifact | undefined {
  return data.artifacts.find((artifact) => artifact.id === artifactId);
}

function acceptedKeys(schemas: readonly SchemaRef[]): Set<string> {
  return new Set(schemas.map(schemaKey));
}

function rejection(
  block: ResultViewBlock,
  reason: string,
): ResultViewBlockEvaluation {
  return {
    blockId: block.id,
    kind: block.kind,
    status: 'rejected',
    ...(block.kind === 'widget' ? { widgetId: block.widgetId } : {}),
    reason,
    artifactIds: [],
    metricIds: [],
    taskIds: [],
  };
}

function evaluation(
  block: ResultViewBlock,
  status: Exclude<ResultViewBlockStatus, 'rejected'>,
  resolved: {
    artifactIds?: string[];
    metricIds?: string[];
    taskIds?: string[];
  },
): ResultViewBlockEvaluation {
  return {
    blockId: block.id,
    kind: block.kind,
    status,
    ...(block.kind === 'widget' ? { widgetId: block.widgetId } : {}),
    artifactIds: resolved.artifactIds ?? [],
    metricIds: resolved.metricIds ?? [],
    taskIds: resolved.taskIds ?? [],
  };
}

/**
 * Resolves one binding against Run data. Missing explicit ids are broken
 * references, never silently dropped. Schema selectors match exact namespaced
 * identities.
 */
function resolveBinding(
  data: ResultViewData,
  binding: ResultViewBinding,
): { artifactIds: string[]; metricIds: string[]; taskIds: string[] } | { missing: string } {
  for (const taskId of binding.taskIds ?? []) {
    if (!data.tasks.some((task) => task.id === taskId)) {
      return { missing: `Task "${taskId}" is not part of this Run.` };
    }
  }
  for (const artifactId of binding.artifactIds ?? []) {
    if (!findArtifactSchema(data, artifactId)) {
      return { missing: `Artifact "${artifactId}" is not part of this Run.` };
    }
  }
  for (const metricId of binding.metricIds ?? []) {
    if (!data.metrics.some((metric) => metric.id === metricId)) {
      return { missing: `Metric "${metricId}" is not part of this Run.` };
    }
  }

  const explicitArtifacts = new Set(binding.artifactIds ?? []);
  const explicitMetrics = new Set(binding.metricIds ?? []);
  const explicitTasks = new Set(binding.taskIds ?? []);
  const artifactSelectors = acceptedKeys(binding.artifactSchemas ?? []);
  const metricSelectors = acceptedKeys(binding.metricSchemas ?? []);

  const artifactIds = data.artifacts
    .filter(
      (artifact) =>
        explicitArtifacts.has(artifact.id) ||
        (artifact.schema !== undefined && artifactSelectors.has(schemaKey(artifact.schema))),
    )
    .map((artifact) => artifact.id);
  const metricIds = data.metrics
    .filter(
      (metric) =>
        explicitMetrics.has(metric.id) ||
        metricSelectors.has(schemaKey(metric.schema)),
    )
    .map((metric) => metric.id);
  const taskIds = data.tasks
    .filter((task) => explicitTasks.has(task.id))
    .map((task) => task.id);

  return { artifactIds, metricIds, taskIds };
}

function usesBinding(binding: ResultViewBinding): boolean {
  return [
    binding.artifactIds,
    binding.metricIds,
    binding.taskIds,
    binding.artifactSchemas,
    binding.metricSchemas,
  ].some((value) => value !== undefined && value.length > 0);
}

function evaluateWidgetBlock(
  block: Extract<ResultViewBlock, { kind: 'widget' }>,
  data: ResultViewData,
  widgets: readonly WidgetDescriptor[],
): ResultViewBlockEvaluation {
  const widget = widgets.find((candidate) => candidate.id === block.widgetId);
  if (!widget) {
    return rejection(block, `Widget "${block.widgetId}" is not registered.`);
  }
  if (!usesBinding(block.binding)) {
    return rejection(block, `Widget "${widget.id}" has no data binding.`);
  }

  const acceptedArtifacts = acceptedKeys(widget.acceptedArtifactSchemas);
  const acceptedMetrics = acceptedKeys(widget.acceptedMetricSchemas);

  for (const schema of block.binding.artifactSchemas ?? []) {
    if (!acceptedArtifacts.has(schemaKey(schema))) {
      return rejection(
        block,
        `Widget "${widget.id}" does not accept binding schema ${schemaKey(schema)}; accepted Artifact schemas are ${[
          ...acceptedArtifacts,
        ].join(', ') || 'none'}.`,
      );
    }
  }
  for (const schema of block.binding.metricSchemas ?? []) {
    if (!acceptedMetrics.has(schemaKey(schema))) {
      return rejection(
        block,
        `Widget "${widget.id}" does not accept binding schema ${schemaKey(schema)}; accepted Metric schemas are ${[
          ...acceptedMetrics,
        ].join(', ') || 'none'}.`,
      );
    }
  }

  // An explicit id is a strict request: a Widget must not receive data whose
  // schema it did not declare.
  for (const artifactId of block.binding.artifactIds ?? []) {
    const artifact = data.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) continue; // reported by resolveBinding
    if (!artifact.schema || !acceptedArtifacts.has(schemaKey(artifact.schema))) {
      return rejection(
        block,
        `Widget "${widget.id}" cannot consume Artifact "${artifact.name}" schema ${
          artifact.schema ? schemaKey(artifact.schema) : 'none'
        }; accepted Artifact schemas are ${[...acceptedArtifacts].join(', ') || 'none'}.`,
      );
    }
  }
  for (const metricId of block.binding.metricIds ?? []) {
    const metric = data.metrics.find((candidate) => candidate.id === metricId);
    if (!metric) continue;
    if (!acceptedMetrics.has(schemaKey(metric.schema))) {
      return rejection(
        block,
        `Widget "${widget.id}" cannot consume Metric "${metric.name}" schema ${schemaKey(
          metric.schema,
        )}; accepted Metric schemas are ${[...acceptedMetrics].join(', ') || 'none'}.`,
      );
    }
  }

  const resolved = resolveBinding(data, block.binding);
  if ('missing' in resolved) return rejection(block, resolved.missing);

  const hasData = resolved.artifactIds.length > 0 || resolved.metricIds.length > 0;
  return evaluation(block, hasData ? 'compatible' : 'empty', resolved);
}

function evaluateBlock(
  block: ResultViewBlock,
  data: ResultViewData,
  widgets: readonly WidgetDescriptor[],
): ResultViewBlockEvaluation {
  if (block.kind === 'logs') {
    const resolved = resolveBinding(data, {
      ...(block.binding.taskIds ? { taskIds: block.binding.taskIds } : {}),
    });
    if ('missing' in resolved) return rejection(block, resolved.missing);
    return evaluation(block, 'compatible', {
      taskIds:
        block.binding.taskIds !== undefined
          ? resolved.taskIds
          : data.tasks.map((task) => task.id),
    });
  }

  if (block.kind === 'widget') {
    return evaluateWidgetBlock(block, data, widgets);
  }

  const resolved = resolveBinding(data, block.binding);
  if ('missing' in resolved) return rejection(block, resolved.missing);

  if (block.kind === 'artifacts') {
    const artifactIds = resolved.artifactIds.length > 0 ? resolved.artifactIds : data.artifacts.map((a) => a.id);
    return evaluation(block, artifactIds.length > 0 ? 'compatible' : 'empty', {
      artifactIds,
    });
  }

  if (block.kind === 'candidates') {
    const selectors = block.binding.artifactSchemas ?? [CANDIDATE_SET_SCHEMA_REF];
    const candidateKeys = acceptedKeys(selectors);
    for (const artifactId of block.binding.artifactIds ?? []) {
      const artifact = data.artifacts.find((candidate) => candidate.id === artifactId);
      if (!artifact) continue;
      if (!artifact.schema || !candidateKeys.has(schemaKey(artifact.schema))) {
        return rejection(
          block,
          `Candidates block cannot render Artifact "${artifact.name}" schema ${
            artifact.schema ? schemaKey(artifact.schema) : 'none'
          }.`,
        );
      }
    }
    const allowed = new Set(
      data.artifacts
        .filter(
          (artifact) =>
            artifact.schema !== undefined && candidateKeys.has(schemaKey(artifact.schema)),
        )
        .map((artifact) => artifact.id),
    );
    const artifactIds = resolved.artifactIds.filter((id) => allowed.has(id));
    return evaluation(block, artifactIds.length > 0 ? 'compatible' : 'empty', {
      artifactIds,
    });
  }

  if (block.kind === 'metrics') {
    const metricIds =
      resolved.metricIds.length > 0
        ? resolved.metricIds
        : data.metrics.map((metric) => metric.id);
    return evaluation(block, metricIds.length > 0 ? 'compatible' : 'empty', {
      metricIds,
    });
  }

  // Provenance links Artifacts, Metrics, and Task attempts back to the Run.
  const artifactIds =
    resolved.artifactIds.length > 0 || block.binding.artifactIds !== undefined
      ? resolved.artifactIds
      : data.artifacts.map((artifact) => artifact.id);
  const metricIds =
    resolved.metricIds.length > 0 || block.binding.metricIds !== undefined
      ? resolved.metricIds
      : data.metrics.map((metric) => metric.id);
  const taskIds =
    resolved.taskIds.length > 0
      ? resolved.taskIds
      : data.tasks.map((task) => task.id);
  const hasProvenance = artifactIds.length > 0 || metricIds.length > 0;
  return evaluation(block, hasProvenance ? 'compatible' : 'empty', {
    artifactIds,
    metricIds,
    taskIds,
  });
}

/**
 * Shared binding/schema-compatibility validation. The Server runs it when it
 * assembles a Result View response and the Web client runs it again before
 * rendering, so an incompatible Widget binding is rejected at both seams and
 * never receives coerced scientific data.
 */
export function validateResultViewBindings(
  ir: ResultViewIR,
  data: ResultViewData,
  widgets: readonly WidgetDescriptor[],
): ResultViewCompatibilityReport {
  const blocks = ir.blocks.map((block) => evaluateBlock(block, data, widgets));
  const rejected = blocks
    .filter(
      (block): block is ResultViewBlockEvaluation & { status: 'rejected' } =>
        block.status === 'rejected',
    )
    .map((block) => ({
      blockId: block.blockId,
      ...(block.widgetId ? { widgetId: block.widgetId } : {}),
      reason: block.reason ?? 'The binding is incompatible.',
    }));

  return {
    accepted: unique(
      blocks.filter((block) => block.status === 'compatible').map((block) => block.blockId),
    ),
    empty: unique(
      blocks.filter((block) => block.status === 'empty').map((block) => block.blockId),
    ),
    rejected,
    blocks,
  };
}

export const ResultViewResponseSchema = z.strictObject({
  resultView: ResultViewIRSchema,
  /**
   * Persisted revision of the Result View row. It is row metadata and never
   * part of the strict Result View IR, so Agent patches can detect stale bases
   * without changing the durable page description.
   */
  revision: z.number().int().nonnegative(),
  widgets: z.array(WidgetDescriptorSchema),
  data: ResultViewDataSchema,
  compatibility: ResultViewCompatibilityReportSchema,
});
export type ResultViewResponse = z.infer<typeof ResultViewResponseSchema>;
