import { SLURM_TASK_INPUT_FILE, type NodeManifest } from '@sflow/domain';

/**
 * Production structure-prediction Node Manifest.
 *
 * This is the first real model replacement for a deterministic Binder fixture.
 * It keeps the deterministic Manifests' scientific and execution contract
 * exactly (ports, generated-form parameters, outputs, Metrics, resources, and
 * retry policy) and only advances the implementation version and the OCI
 * environment. The container command consumes the Task input contract written
 * by the Slurm Compute Executor and writes the ticket #12 `result.json`
 * contract next to its output files.
 *
 * No model weights or network access are required for this slice: the package
 * ships a deterministic simulation of the production container entrypoint.
 */

export const STRUCTURE_PREDICTION_PRODUCTION_VERSION = '2.0.0';

export const STRUCTURE_PREDICTION_PRODUCTION_IMAGE =
  'ghcr.io/sflow/nodes/structure-prediction-production:2.0.0';

/** Task result file read by the Slurm executor (ticket #12 protocol). */
export const STRUCTURE_PREDICTION_RESULT_FILE = 'result.json';

export const STRUCTURE_PREDICTION_PRODUCTION_COMMAND: readonly string[] = [
  'sflow-structure-prediction',
  'predict',
  '--task-input',
  // Shared contract written by the Slurm Compute Executor.
  SLURM_TASK_INPUT_FILE,
  '--result',
  STRUCTURE_PREDICTION_RESULT_FILE,
];

export const structurePredictionProductionManifest: NodeManifest = {
  id: 'structure-prediction',
  version: STRUCTURE_PREDICTION_PRODUCTION_VERSION,
  name: 'Structure prediction',
  description:
    'Production structure-prediction model container that predicts and scores candidate structures, producing confidence Metrics for comparison.',
  category: 'Structure prediction',
  type: 'predictor',
  inputs: [
    {
      id: 'designs',
      name: 'Designed sequences',
      direction: 'input',
      kind: 'data',
      dataType: 'candidate-set',
      required: true,
    },
    {
      id: 'control-in',
      name: 'Start',
      direction: 'input',
      kind: 'control',
      required: true,
    },
  ],
  outputs: [
    {
      id: 'scored',
      name: 'Scored candidates',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
    },
    {
      id: 'structures',
      name: 'Predicted structures',
      direction: 'output',
      kind: 'data',
      dataType: 'artifact-set',
    },
    {
      id: 'control-out',
      name: 'Next',
      direction: 'output',
      kind: 'control',
    },
  ],
  parameters: [
    {
      id: 'predictor',
      name: 'Structure predictor',
      type: 'enum',
      options: [
        { value: 'esmfold2', label: 'ESMFold2' },
        { value: 'alphafold3', label: 'AlphaFold3' },
      ],
      default: 'esmfold2',
      required: true,
    },
    {
      id: 'recycles',
      name: 'Recycles',
      type: 'number',
      default: 3,
      min: 1,
      max: 12,
      integer: true,
    },
    {
      id: 'batchSize',
      name: 'Batch size',
      type: 'number',
      default: 4,
      min: 1,
      max: 64,
      integer: true,
    },
    {
      id: 'seed',
      name: 'Random seed',
      type: 'number',
      default: 1,
      integer: true,
    },
  ],
  metrics: [
    {
      id: 'meanPlddt',
      name: 'Mean pLDDT',
      description: 'Mean predicted local distance difference test score.',
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 100 },
      direction: 'higher-is-better',
    },
    {
      id: 'meanIptm',
      name: 'Mean ipTM',
      description: 'Mean interface predicted TM-score for binder-target complexes.',
      valueType: 'number',
      unit: 'score',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
    },
    {
      id: 'scoredCount',
      name: 'Scored candidates',
      description: 'Candidates scored by structure prediction.',
      valueType: 'number',
      scale: { min: 0 },
      direction: 'neutral',
    },
  ],
  resources: {
    cpu: 8,
    memory: '48Gi',
    gpu: 1,
    gpuType: 'A100',
    walltimeMinutes: 180,
  },
  environment: {
    kind: 'container',
    image: STRUCTURE_PREDICTION_PRODUCTION_IMAGE,
    command: [...STRUCTURE_PREDICTION_PRODUCTION_COMMAND],
    variables: {
      SFLOW_MODEL_ARTIFACT: 'structure-prediction-production-2.0.0',
    },
  },
  retry: { maxAttempts: 2, backoffSeconds: 60, retryOn: ['transient', 'timeout'] },
};
