import type { NodeManifest } from '@sflow/domain';

/**
 * Production-shaped Binder Node Manifests (ticket #5).
 *
 * These are contract metadata only: ports, generated-form parameter specs,
 * scientific outputs and Metrics, resource requirements, environment, and
 * retry policy. Model execution is deliberately absent; ticket #7 supplies the
 * deterministic test Node implementations without changing these contracts.
 */

const VERSION = '1.0.0';

function imageFor(id: string): string {
  return `ghcr.io/sflow/nodes/${id}:${VERSION}`;
}

export const targetInputManifest: NodeManifest = {
  id: 'target-input',
  version: VERSION,
  name: 'Target input',
  description:
    'Load a path-backed target structure and declare the design chain and hotspot residues.',
  category: 'Inputs',
  type: 'input',
  inputs: [],
  outputs: [
    {
      id: 'target',
      name: 'Target structure',
      direction: 'output',
      kind: 'data',
      dataType: 'target-structure',
      description: 'The selected path-backed target structure.',
    },
    {
      id: 'control-out',
      name: 'Start',
      direction: 'output',
      kind: 'control',
      description: 'Signals that the target is ready for downstream Nodes.',
    },
  ],
  parameters: [
    {
      id: 'targetFile',
      name: 'Target file',
      description: 'A path-backed Project File Reference for the target structure.',
      type: 'file-reference',
      accept: ['.pdb', '.cif'],
      required: true,
    },
    {
      id: 'targetChain',
      name: 'Target chain',
      type: 'enum',
      options: [
        { value: 'A', label: 'Chain A' },
        { value: 'B', label: 'Chain B' },
        { value: 'C', label: 'Chain C' },
      ],
      default: 'A',
      description: 'Chain used as the binder target.',
    },
    {
      id: 'hotspotResidues',
      name: 'Hotspot residues',
      type: 'string',
      default: '',
      description: 'Optional comma-separated residue positions to prioritize.',
    },
  ],
  metrics: [
    {
      id: 'targetResidueCount',
      name: 'Target residues',
      description: 'Residues observed on the selected target chain.',
      valueType: 'number',
    },
  ],
  resources: { cpu: 1, memory: '2Gi', walltimeMinutes: 10 },
  environment: {
    kind: 'container',
    image: imageFor('target-input'),
  },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
};

export const candidateGenerationManifest: NodeManifest = {
  id: 'candidate-generation',
  version: VERSION,
  name: 'Candidate generation',
  description:
    'Generate an initial CandidateSet from the target using a deterministic design strategy.',
  category: 'Protein design',
  type: 'generator',
  inputs: [
    {
      id: 'target',
      name: 'Target structure',
      direction: 'input',
      kind: 'data',
      dataType: 'target-structure',
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
      id: 'candidates',
      name: 'Candidates',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
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
      id: 'numCandidates',
      name: 'Candidate count',
      type: 'number',
      default: 100,
      min: 1,
      max: 10_000,
      integer: true,
      required: true,
    },
    {
      id: 'seed',
      name: 'Random seed',
      type: 'number',
      default: 42,
      integer: true,
      required: true,
    },
    {
      id: 'strategy',
      name: 'Generation strategy',
      type: 'enum',
      options: [
        { value: 'random', label: 'Random' },
        { value: 'cdr-focused', label: 'CDR-focused' },
      ],
      default: 'random',
    },
    {
      id: 'useTargetHotspots',
      name: 'Use target hotspots',
      type: 'boolean',
      default: true,
    },
    {
      id: 'designNote',
      name: 'Design note',
      type: 'string',
      default: '',
      description: 'Optional note carried into CandidateSet provenance.',
    },
  ],
  metrics: [
    {
      id: 'candidateCount',
      name: 'Candidate count',
      valueType: 'number',
      direction: 'neutral',
    },
    {
      id: 'uniqueCandidates',
      name: 'Unique candidates',
      valueType: 'number',
      direction: 'neutral',
    },
  ],
  resources: { cpu: 4, memory: '8Gi', walltimeMinutes: 30 },
  environment: {
    kind: 'container',
    image: imageFor('candidate-generation'),
  },
  retry: { maxAttempts: 2, backoffSeconds: 30, retryOn: ['transient', 'exit-code'] },
};

export const sequenceDesignManifest: NodeManifest = {
  id: 'sequence-design',
  version: VERSION,
  name: 'Sequence design',
  description:
    'Design VHH binder sequences for each generated candidate with a sequence model.',
  category: 'Protein design',
  type: 'designer',
  inputs: [
    {
      id: 'candidates',
      name: 'Candidates',
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
      id: 'designs',
      name: 'Designed sequences',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
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
      id: 'model',
      name: 'Sequence model',
      type: 'enum',
      options: [
        { value: 'vhh-designer-v1', label: 'VHH Designer v1' },
        { value: 'vhh-designer-v2', label: 'VHH Designer v2' },
      ],
      default: 'vhh-designer-v1',
      required: true,
    },
    {
      id: 'temperature',
      name: 'Sampling temperature',
      type: 'number',
      default: 0.7,
      min: 0.1,
      max: 2,
    },
    {
      id: 'numDesigns',
      name: 'Design count',
      type: 'number',
      default: 50,
      min: 1,
      max: 1_000,
      integer: true,
    },
    {
      id: 'randomSeed',
      name: 'Random seed',
      type: 'number',
      default: 7,
      integer: true,
    },
    {
      id: 'trimTerminalTags',
      name: 'Trim terminal tags',
      type: 'boolean',
      default: true,
    },
  ],
  metrics: [
    {
      id: 'meanConfidence',
      name: 'Mean sequence confidence',
      valueType: 'number',
      unit: 'score',
      direction: 'higher-is-better',
    },
    {
      id: 'designCount',
      name: 'Design count',
      valueType: 'number',
      direction: 'neutral',
    },
  ],
  resources: {
    cpu: 8,
    memory: '32Gi',
    gpu: 1,
    gpuType: 'A100',
    walltimeMinutes: 120,
  },
  environment: {
    kind: 'container',
    image: imageFor('sequence-design'),
  },
  retry: { maxAttempts: 2, backoffSeconds: 60, retryOn: ['transient', 'timeout'] },
};

export const structurePredictionManifest: NodeManifest = {
  id: 'structure-prediction',
  version: VERSION,
  name: 'Structure prediction',
  description:
    'Predict and score candidate structures, producing confidence Metrics for comparison.',
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
      direction: 'higher-is-better',
    },
    {
      id: 'meanIptm',
      name: 'Mean ipTM',
      description: 'Mean interface predicted TM-score for binder-target complexes.',
      valueType: 'number',
      unit: 'score',
      direction: 'higher-is-better',
    },
    {
      id: 'scoredCount',
      name: 'Scored candidates',
      valueType: 'number',
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
    image: imageFor('structure-prediction'),
  },
  retry: { maxAttempts: 2, backoffSeconds: 60, retryOn: ['transient', 'timeout'] },
};

export const candidateComparisonManifest: NodeManifest = {
  id: 'candidate-comparison',
  version: VERSION,
  name: 'Candidate comparison',
  description:
    'Rank scored candidates, select the top designs, and produce a comparison report.',
  category: 'Analysis',
  type: 'analysis',
  inputs: [
    {
      id: 'scored',
      name: 'Scored candidates',
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
      id: 'ranking',
      name: 'Ranked candidates',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
    },
    {
      id: 'report',
      name: 'Comparison report',
      direction: 'output',
      kind: 'data',
      dataType: 'comparison-report',
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
      id: 'topN',
      name: 'Top N',
      type: 'number',
      default: 10,
      min: 1,
      max: 1_000,
      integer: true,
      required: true,
    },
    {
      id: 'rankingMetric',
      name: 'Ranking Metric',
      type: 'enum',
      options: [
        { value: 'plddt', label: 'pLDDT' },
        { value: 'iptm', label: 'ipTM' },
        { value: 'binding-score', label: 'Binding score' },
      ],
      default: 'plddt',
      required: true,
    },
    {
      id: 'deduplicate',
      name: 'Deduplicate sequences',
      type: 'boolean',
      default: true,
    },
    {
      id: 'label',
      name: 'Comparison label',
      type: 'string',
      default: 'round-1',
      maxLength: 100,
    },
  ],
  metrics: [
    {
      id: 'selectedCount',
      name: 'Selected candidates',
      valueType: 'number',
      direction: 'neutral',
    },
    {
      id: 'bestPlddt',
      name: 'Best pLDDT',
      valueType: 'number',
      unit: 'score',
      direction: 'higher-is-better',
    },
  ],
  resources: { cpu: 2, memory: '8Gi', walltimeMinutes: 15 },
  environment: {
    kind: 'container',
    image: imageFor('candidate-comparison'),
  },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
};

/** Catalog order drives Node Library category order and default presentation. */
export const builtinManifests: readonly NodeManifest[] = [
  targetInputManifest,
  candidateGenerationManifest,
  sequenceDesignManifest,
  structurePredictionManifest,
  candidateComparisonManifest,
];

export function builtinManifestById(id: string): NodeManifest | undefined {
  return builtinManifests.find((manifest) => manifest.id === id);
}

export const NODES_PACKAGE = '@sflow/nodes';
