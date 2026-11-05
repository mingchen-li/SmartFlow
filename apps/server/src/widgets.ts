import type { FastifyInstance } from 'fastify';
import {
  CANDIDATE_SET_SCHEMA_REF,
  PREDICTED_STRUCTURE_SCHEMA_REF,
  type SchemaRef,
  type WidgetCatalogResponse,
  type WidgetDescriptor,
} from '@sflow/domain';

/**
 * Registered Result View Widgets. These declarations are the extension
 * contract: each Widget names the exact Artifact and Metric schemas it can
 * consume and the interactions it supports. No arbitrary frontend code is
 * registered or generated here (ADR-0006).
 */

function metricSchema(manifestId: string, metricId: string): SchemaRef {
  return {
    namespace: `sflow.binder.${manifestId}`,
    name: metricId,
    version: '1.0.0',
  };
}

export const candidateTableWidget: WidgetDescriptor = {
  id: 'sflow.candidate-table',
  version: '1.0.0',
  name: 'Candidate table',
  description:
    'Renders CandidateSet candidates with ranks, sequences, and candidate-level scores.',
  acceptedArtifactSchemas: [CANDIDATE_SET_SCHEMA_REF],
  acceptedMetricSchemas: [],
  interactions: ['inspect', 'download', 'select-candidate'],
};

export const metricSummaryWidget: WidgetDescriptor = {
  id: 'sflow.metric-summary',
  version: '1.0.0',
  name: 'Metric summary',
  description:
    'Shows typed scientific Metrics with meaning, unit or scale, and Provenance links.',
  acceptedArtifactSchemas: [],
  acceptedMetricSchemas: [
    metricSchema('structure-prediction', 'meanPlddt'),
    metricSchema('structure-prediction', 'meanIptm'),
    metricSchema('sequence-design', 'meanConfidence'),
    metricSchema('candidate-comparison', 'bestPlddt'),
  ],
  interactions: ['inspect', 'open-provenance'],
};

export const structureViewerWidget: WidgetDescriptor = {
  id: 'sflow.structure-viewer',
  version: '1.0.0',
  name: 'Structure viewer',
  description:
    'Inspects and downloads predicted structures recorded as managed Artifacts.',
  acceptedArtifactSchemas: [PREDICTED_STRUCTURE_SCHEMA_REF],
  acceptedMetricSchemas: [],
  interactions: ['inspect', 'download'],
};

/** Registration order is presentation order in the default Result View. */
export const builtinWidgetDescriptors: readonly WidgetDescriptor[] = [
  candidateTableWidget,
  metricSummaryWidget,
  structureViewerWidget,
];

export function findWidgetDescriptor(id: string): WidgetDescriptor | undefined {
  return builtinWidgetDescriptors.find((widget) => widget.id === id);
}

/**
 * Reads the Widget registry. Results Agents and future extensions compose
 * these registered descriptors; they cannot submit render code.
 */
export function registerWidgetRoutes(app: FastifyInstance): void {
  app.get('/api/widgets', async (): Promise<WidgetCatalogResponse> => ({
    widgets: [...builtinWidgetDescriptors],
  }));
}
