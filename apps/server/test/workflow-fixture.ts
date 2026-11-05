import {
  defaultParameters,
  type FileReference,
  type NodeManifest,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinManifestById } from '@sflow/nodes';

/** Shared Binder Workflow fixture for Server integration tests. */

export const DRAFT_ID = 'binder-design';

export function manifest(id: string): NodeManifest {
  const value = builtinManifestById(id);
  if (!value) throw new Error(`Missing built-in Manifest ${id}`);
  return value;
}

export const emptyLayout = {
  version: 1,
  positions: {},
  viewport: { x: 0, y: 0, zoom: 0.86 },
  selection: { nodeId: null, edgeId: null },
};

export const NODE_IDS = {
  target: 'node-target',
  generator: 'node-generator',
  designer: 'node-designer',
  predictor: 'node-predictor',
  comparison: 'node-comparison',
};

export function buildWorkflow(fileReference: FileReference): WorkflowIR {
  const params = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...defaultParameters(manifest(id)),
    ...overrides,
  });

  const nodes: WorkflowIR['nodes'] = [
    {
      id: NODE_IDS.target,
      manifestId: 'target-input',
      manifestVersion: '1.0.0',
      label: 'Target input',
      parameters: params('target-input', {
        targetFile: {
          fileReferenceId: fileReference.id,
          path: fileReference.path,
          name: fileReference.name,
        },
      }),
      resources: {},
    },
    {
      id: NODE_IDS.generator,
      manifestId: 'candidate-generation',
      manifestVersion: '1.0.0',
      label: 'Candidate generation',
      parameters: params('candidate-generation', {
        numCandidates: 5,
        seed: 42,
        strategy: 'cdr-focused',
      }),
      resources: {},
    },
    {
      id: NODE_IDS.designer,
      manifestId: 'sequence-design',
      manifestVersion: '1.0.0',
      label: 'Sequence design',
      parameters: params('sequence-design', { numDesigns: 3, randomSeed: 7 }),
      resources: {},
    },
    {
      id: NODE_IDS.predictor,
      manifestId: 'structure-prediction',
      manifestVersion: '1.0.0',
      label: 'Structure prediction',
      parameters: params('structure-prediction', { seed: 1 }),
      resources: {},
    },
    {
      id: NODE_IDS.comparison,
      manifestId: 'candidate-comparison',
      manifestVersion: '1.0.0',
      label: 'Candidate comparison',
      parameters: params('candidate-comparison', { topN: 2, label: 'round-1' }),
      resources: {},
    },
  ];

  const connect = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ): WorkflowIR['edges'][number] => ({ id, source, sourcePort, target, targetPort });

  return {
    version: 1,
    id: DRAFT_ID,
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
}

export const TARGET_PDB = [
  'HEADER TARGET',
  'ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N',
  'ATOM      2  CA  ALA A   1      12.560   6.134  -6.504  1.00  0.00           C',
  'ATOM      3  N   GLY A   2      13.104   7.134  -6.504  1.00  0.00           N',
  'END',
].join('\n');
