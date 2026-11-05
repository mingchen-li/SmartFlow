import type { NodeImplementation } from '@sflow/domain';
import { structurePredictionProductionManifest } from './manifest';
import { runProductionStructurePrediction } from './run';

export * from './manifest';
export * from './run';
export * from './container';

/**
 * Registry entry for the production Node. Compose it with the built-in
 * deterministic registry via `CreateProjectServerOptions.nodeImplementations`;
 * the Manifest catalog, Workflow validation, Run snapshots, and executors all
 * resolve the replacement by `id@version` without special cases.
 */
export const productionStructurePredictionImplementation: NodeImplementation = {
  manifest: structurePredictionProductionManifest,
  run: runProductionStructurePrediction,
};

export const productionStructurePredictionImplementations: readonly NodeImplementation[] = [
  productionStructurePredictionImplementation,
];
