import { describe, expect, it } from 'vitest';
import {
  EditorLayoutSchema,
  NodeManifestSchema,
  WorkflowIRSchema,
  defaultParameters,
  findManifest,
  validateConnection,
  validateParameters,
  type NodeManifest,
  type WorkflowIR,
} from '@sflow/domain';

/**
 * A small, hand-written manifest used to pin contract behavior independently
 * of the built-in Binder catalog.
 */
const generatorManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'generator',
  version: '1.0.0',
  name: 'Generator',
  description: 'Generate candidates from a target.',
  category: 'Design',
  type: 'generator',
  inputs: [
    {
      id: 'target',
      name: 'Target',
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
      id: 'count',
      name: 'Count',
      type: 'number',
      default: 100,
      min: 1,
      max: 1000,
      integer: true,
      required: true,
    },
    {
      id: 'strategy',
      name: 'Strategy',
      type: 'enum',
      options: [{ value: 'random' }, { value: 'focused' }],
      default: 'random',
    },
    { id: 'seed', name: 'Seed', type: 'number', default: 42, integer: true },
    { id: 'verbose', name: 'Verbose', type: 'boolean', default: false },
    { id: 'label', name: 'Label', type: 'string', default: 'run' },
    { id: 'targetFile', name: 'Target file', type: 'file-reference', required: true },
  ],
  metrics: [{ id: 'candidateCount', name: 'Candidates', valueType: 'number' }],
  resources: { cpu: 2, memory: '8Gi', gpu: 0, walltimeMinutes: 60 },
  environment: { kind: 'container', image: 'registry.example/generator:1.0.0' },
  retry: { maxAttempts: 2, backoffSeconds: 30, retryOn: ['transient'] },
});

const consumerManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'consumer',
  version: '1.0.0',
  name: 'Consumer',
  description: 'Rank candidates.',
  category: 'Analysis',
  type: 'analysis',
  inputs: [
    {
      id: 'candidates',
      name: 'Candidates',
      direction: 'input',
      kind: 'data',
      dataType: 'candidate-set',
      required: true,
    },
    { id: 'control-in', name: 'Start', direction: 'input', kind: 'control', required: true },
  ],
  outputs: [
    { id: 'report', name: 'Report', direction: 'output', kind: 'data', dataType: 'report' },
    { id: 'control-out', name: 'Next', direction: 'output', kind: 'control' },
  ],
  parameters: [{ id: 'topN', name: 'Top N', type: 'number', default: 10, min: 1 }],
  metrics: [{ id: 'selectedCount', name: 'Selected', valueType: 'number' }],
  resources: { cpu: 1, memory: '2Gi' },
  environment: { kind: 'container', image: 'registry.example/consumer:1.0.0' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
});

const manifests = [generatorManifest, consumerManifest];

function workflowWith(nodes: WorkflowIR['nodes'], edges: WorkflowIR['edges'] = []): WorkflowIR {
  return { version: 1, nodes, edges };
}

const generatorNode: WorkflowIR['nodes'][number] = {
  id: 'generator-1',
  manifestId: 'generator',
  manifestVersion: '1.0.0',
  label: 'Generator',
  parameters: { count: 100, strategy: 'random' },
  resources: {},
};

const consumerNode: WorkflowIR['nodes'][number] = {
  id: 'consumer-1',
  manifestId: 'consumer',
  manifestVersion: '1.0.0',
  label: 'Consumer',
  parameters: { topN: 10 },
  resources: {},
};

describe('WorkflowIR', () => {
  it('represents Node instances, parameters, resources, and edges', () => {
    const parsed = WorkflowIRSchema.parse(
      workflowWith([generatorNode, consumerNode], [
        {
          id: 'edge-1',
          source: 'generator-1',
          sourcePort: 'candidates',
          target: 'consumer-1',
          targetPort: 'candidates',
        },
      ]),
    );

    expect(parsed.nodes[0]).toMatchObject({
      manifestId: 'generator',
      manifestVersion: '1.0.0',
      parameters: { count: 100, strategy: 'random' },
      resources: {},
    });
    expect(parsed.edges[0].sourcePort).toBe('candidates');
  });

  it('rejects canvas layout leaking into execution semantics', () => {
    const withPosition = {
      ...generatorNode,
      position: { x: 10, y: 20 },
    } as unknown as WorkflowIR['nodes'][number];

    expect(WorkflowIRSchema.safeParse(workflowWith([withPosition])).success).toBe(false);
    expect(
      WorkflowIRSchema.safeParse({
        ...workflowWith([]),
        viewport: { x: 0, y: 0, zoom: 1 },
      }).success,
    ).toBe(false);
  });

  it('requires a Manifest id and version on every Node instance', () => {
    const missingVersion = { ...generatorNode, manifestVersion: undefined };
    expect(
      WorkflowIRSchema.safeParse(workflowWith([missingVersion as never])).success,
    ).toBe(false);
  });
});

describe('EditorLayout', () => {
  it('keeps positions, viewport, and selection separate from Workflow IR', () => {
    const layout = EditorLayoutSchema.parse({
      version: 1,
      positions: { 'generator-1': { x: 120, y: 64 } },
      viewport: { x: -20, y: 10, zoom: 0.86 },
      selection: { nodeId: 'generator-1', edgeId: null },
    });

    expect(layout.positions['generator-1']).toEqual({ x: 120, y: 64 });
    expect(layout.viewport.zoom).toBe(0.86);
    expect(layout.selection.nodeId).toBe('generator-1');
    expect(WorkflowIRSchema.parse(workflowWith([generatorNode])).nodes[0]).not.toHaveProperty(
      'position',
    );
  });
});

describe('NodeManifest', () => {
  it('validates ports, parameter specs, metrics, resources, environment, and retry policy', () => {
    expect(generatorManifest.inputs.map((port) => port.id)).toEqual([
      'target',
      'control-in',
    ]);
    expect(generatorManifest.metrics[0].id).toBe('candidateCount');
    expect(generatorManifest.resources).toMatchObject({ cpu: 2, memory: '8Gi', gpu: 0 });
    expect(generatorManifest.environment.kind).toBe('container');
    expect(generatorManifest.retry.maxAttempts).toBe(2);
  });

  it('rejects duplicate port ids', () => {
    expect(() =>
      NodeManifestSchema.parse({
        ...generatorManifest,
        inputs: [
          { id: 'target', name: 'A', direction: 'input', kind: 'data', dataType: 'x' },
          { id: 'target', name: 'B', direction: 'input', kind: 'data', dataType: 'y' },
        ],
      }),
    ).toThrow();
  });

  it('finds a manifest by id and optional version', () => {
    expect(findManifest(manifests, 'generator')?.name).toBe('Generator');
    expect(findManifest(manifests, 'generator', '1.0.0')?.name).toBe('Generator');
    expect(findManifest(manifests, 'generator', '2.0.0')).toBeUndefined();
    expect(findManifest(manifests, 'missing')).toBeUndefined();
  });
});

describe('Manifest-generated configuration', () => {
  it('derives default parameters and omits parameters without defaults', () => {
    const defaults = defaultParameters(generatorManifest);

    expect(defaults).toEqual({
      count: 100,
      strategy: 'random',
      seed: 42,
      verbose: false,
      label: 'run',
    });
    expect(defaults).not.toHaveProperty('targetFile');
  });

  it('validates parameter values against their declared specs', () => {
    const fileReference = {
      fileReferenceId: 'ref-1',
      path: 'target.pdb',
      name: 'target.pdb',
    };

    expect(
      validateParameters(generatorManifest, {
        ...defaultParameters(generatorManifest),
        targetFile: fileReference,
      }),
    ).toEqual([]);

    const missingRequired = validateParameters(
      generatorManifest,
      defaultParameters(generatorManifest),
    );
    expect(missingRequired).toEqual([
      expect.objectContaining({ path: 'targetFile' }),
    ]);

    const invalid = validateParameters(generatorManifest, {
      count: 'many',
      strategy: 'impossible',
      seed: 41.5,
      verbose: 'yes',
      label: 5,
      targetFile: { path: 'target.pdb' },
      extra: true,
    });
    expect(invalid.map((issue) => issue.path).sort()).toEqual(
      ['count', 'extra', 'label', 'seed', 'strategy', 'targetFile', 'verbose'],
    );

    const outOfRange = validateParameters(generatorManifest, {
      ...defaultParameters(generatorManifest),
      count: 5000,
      targetFile: fileReference,
    });
    expect(outOfRange).toEqual([expect.objectContaining({ path: 'count' })]);
  });
});

describe('Connection validation', () => {
  const workflow = workflowWith([generatorNode, consumerNode]);

  it('accepts matching data and control edges', () => {
    const data = validateConnection(workflow, manifests, {
      source: 'generator-1',
      sourcePort: 'candidates',
      target: 'consumer-1',
      targetPort: 'candidates',
    });
    expect(data).toEqual({ valid: true });

    const control = validateConnection(workflow, manifests, {
      source: 'generator-1',
      sourcePort: 'control-out',
      target: 'consumer-1',
      targetPort: 'control-in',
    });
    expect(control).toEqual({ valid: true });
  });

  it('rejects kind, type, and direction mismatches', () => {
    expect(
      validateConnection(workflow, manifests, {
        source: 'generator-1',
        sourcePort: 'control-out',
        target: 'consumer-1',
        targetPort: 'candidates',
      }).valid,
    ).toBe(false);

    expect(
      validateConnection(workflow, manifests, {
        source: 'generator-1',
        sourcePort: 'candidates',
        target: 'consumer-1',
        targetPort: 'control-in',
      }).valid,
    ).toBe(false);

    expect(
      validateConnection(workflow, manifests, {
        source: 'consumer-1',
        sourcePort: 'candidates',
        target: 'generator-1',
        targetPort: 'target',
      }).valid,
    ).toBe(false);
  });

  it('rejects unknown Nodes and ports', () => {
    expect(
      validateConnection(workflow, manifests, {
        source: 'generator-1',
        sourcePort: 'candidates',
        target: 'missing',
        targetPort: 'candidates',
      }).valid,
    ).toBe(false);

    expect(
      validateConnection(workflow, manifests, {
        source: 'generator-1',
        sourcePort: 'missing',
        target: 'consumer-1',
        targetPort: 'candidates',
      }).valid,
    ).toBe(false);
  });

  it('rejects duplicate target connections, self loops, and cycles', () => {
    const connected = workflowWith(
      [generatorNode, consumerNode],
      [
        {
          id: 'edge-1',
          source: 'generator-1',
          sourcePort: 'candidates',
          target: 'consumer-1',
          targetPort: 'candidates',
        },
      ],
    );

    expect(
      validateConnection(connected, manifests, {
        source: 'generator-1',
        sourcePort: 'candidates',
        target: 'consumer-1',
        targetPort: 'candidates',
      }).valid,
    ).toBe(false);

    expect(
      validateConnection(workflow, manifests, {
        source: 'generator-1',
        sourcePort: 'control-out',
        target: 'generator-1',
        targetPort: 'control-in',
      }).valid,
    ).toBe(false);

    const cyclic = workflowWith(
      [generatorNode, consumerNode],
      [
        {
          id: 'edge-1',
          source: 'generator-1',
          sourcePort: 'control-out',
          target: 'consumer-1',
          targetPort: 'control-in',
        },
      ],
    );
    expect(
      validateConnection(cyclic, manifests, {
        source: 'consumer-1',
        sourcePort: 'control-out',
        target: 'generator-1',
        targetPort: 'control-in',
      }).valid,
    ).toBe(false);
  });
});
