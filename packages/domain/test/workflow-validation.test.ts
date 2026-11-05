import { describe, expect, it } from 'vitest';
import {
  BINDER_REQUIRED_OUTPUTS,
  NodeManifestSchema,
  validateWorkflow,
  type NodeManifest,
  type WorkflowIR,
} from '../src';

/**
 * Hand-written Manifests keep this contract test independent of the built-in
 * Binder catalog while still exercising the Binder-required-output policy.
 */
const targetManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'target-input',
  version: '1.0.0',
  name: 'Target input',
  description: 'Load a target structure.',
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
    },
    { id: 'control-out', name: 'Start', direction: 'output', kind: 'control' },
  ],
  parameters: [
    { id: 'targetFile', name: 'Target file', type: 'file-reference', required: true },
    { id: 'targetChain', name: 'Target chain', type: 'string', default: 'A' },
  ],
  metrics: [],
  resources: { cpu: 1, memory: '2Gi', walltimeMinutes: 10 },
  environment: { kind: 'container', image: 'registry.example/target:1.0.0' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
});

const generatorManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'candidate-generation',
  version: '1.0.0',
  name: 'Candidate generation',
  description: 'Generate a candidate set from a target.',
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
    { id: 'control-in', name: 'Start', direction: 'input', kind: 'control', required: true },
  ],
  outputs: [
    {
      id: 'candidates',
      name: 'Candidates',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
    },
    { id: 'control-out', name: 'Next', direction: 'output', kind: 'control' },
  ],
  parameters: [
    { id: 'numCandidates', name: 'Candidate count', type: 'number', default: 100, min: 1, max: 1000, integer: true, required: true },
    { id: 'seed', name: 'Random seed', type: 'number', default: 42, integer: true },
  ],
  metrics: [],
  resources: { cpu: 4, memory: '8Gi', walltimeMinutes: 30 },
  environment: { kind: 'container', image: 'registry.example/generator:1.0.0' },
  retry: { maxAttempts: 2, backoffSeconds: 30, retryOn: ['transient'] },
});

const comparisonManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'candidate-comparison',
  version: '1.0.0',
  name: 'Candidate comparison',
  description: 'Rank candidates and produce a comparison report.',
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
    { id: 'control-in', name: 'Start', direction: 'input', kind: 'control', required: true },
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
    { id: 'control-out', name: 'Next', direction: 'output', kind: 'control' },
  ],
  parameters: [{ id: 'topN', name: 'Top N', type: 'number', default: 10, min: 1 }],
  metrics: [],
  resources: { cpu: 2, memory: '8Gi', walltimeMinutes: 15 },
  environment: { kind: 'container', image: 'registry.example/comparison:1.0.0' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
});

const manifests = [targetManifest, generatorManifest, comparisonManifest];

const fileReference = {
  fileReferenceId: 'ref-1',
  path: 'target.pdb',
  name: 'target.pdb',
};

function targetNode(): WorkflowIR['nodes'][number] {
  return {
    id: 'target-1',
    manifestId: 'target-input',
    manifestVersion: '1.0.0',
    label: 'Target input',
    parameters: { targetFile: fileReference, targetChain: 'A' },
    resources: {},
  };
}

function generatorNode(): WorkflowIR['nodes'][number] {
  return {
    id: 'generator-1',
    manifestId: 'candidate-generation',
    manifestVersion: '1.0.0',
    label: 'Candidate generation',
    parameters: { numCandidates: 100, seed: 42 },
    resources: {},
  };
}

function comparisonNode(): WorkflowIR['nodes'][number] {
  return {
    id: 'comparison-1',
    manifestId: 'candidate-comparison',
    manifestVersion: '1.0.0',
    label: 'Candidate comparison',
    parameters: { topN: 10 },
    resources: {},
  };
}

/** The minimal executable Binder chain: target -> generator -> comparison. */
function completeWorkflow(): WorkflowIR {
  return {
    version: 1,
    nodes: [targetNode(), generatorNode(), comparisonNode()],
    edges: [
      {
        id: 'edge-target-data',
        source: 'target-1',
        sourcePort: 'target',
        target: 'generator-1',
        targetPort: 'target',
      },
      {
        id: 'edge-target-control',
        source: 'target-1',
        sourcePort: 'control-out',
        target: 'generator-1',
        targetPort: 'control-in',
      },
      {
        id: 'edge-generator-data',
        source: 'generator-1',
        sourcePort: 'candidates',
        target: 'comparison-1',
        targetPort: 'scored',
      },
      {
        id: 'edge-generator-control',
        source: 'generator-1',
        sourcePort: 'control-out',
        target: 'comparison-1',
        targetPort: 'control-in',
      },
    ],
  };
}

describe('validateWorkflow', () => {
  it('accepts a complete, executable Binder Workflow', () => {
    const result = validateWorkflow(completeWorkflow(), manifests);

    expect(result).toEqual({ valid: true, diagnostics: [] });
    // The default policy requires the Binder comparison outputs.
    expect(BINDER_REQUIRED_OUTPUTS.map((output) => output.manifestId)).toEqual([
      'candidate-comparison',
      'candidate-comparison',
    ]);
  });

  it('reports a required input that has no connection', () => {
    const workflow = completeWorkflow();
    workflow.edges = workflow.edges.filter(
      (edge) => !(edge.target === 'comparison-1' && edge.targetPort === 'control-in'),
    );

    const result = validateWorkflow(workflow, manifests);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'MISSING_INPUT',
      nodeId: 'comparison-1',
      path: 'nodes.2.inputs.control-in',
      message:
        'Node "Candidate comparison" requires input "Start" ("control-in"), but nothing is connected.',
      correction: 'Connect a control output to "control-in" on "Candidate comparison".',
    });
  });

  it('reports an edge that names an undeclared port and explains which ports exist', () => {
    const workflow = completeWorkflow();
    workflow.edges[0] = { ...workflow.edges[0], sourcePort: 'missing-output' };

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'INVALID_PORT',
      nodeId: 'target-1',
      edgeId: 'edge-target-data',
      path: 'edges.0.sourcePort',
      message:
        'Connection "edge-target-data" uses output port "missing-output", which Node "Target input" does not declare.',
      correction:
        'Connect from one of the declared outputs on "Target input": target, control-out.',
    });
  });

  it('reports control-to-data and data-type mismatches', () => {
    const kindMismatch = completeWorkflow();
    kindMismatch.edges = kindMismatch.edges.filter(
      (edge) => edge.id !== 'edge-target-data',
    );
    kindMismatch.edges[0] = { ...kindMismatch.edges[0], targetPort: 'target' };

    const kindResult = validateWorkflow(kindMismatch, manifests);
    expect(kindResult.diagnostics).toContainEqual({
      severity: 'error',
      code: 'INVALID_CONNECTION',
      nodeId: 'generator-1',
      edgeId: 'edge-target-control',
      path: 'edges.0.targetPort',
      message:
        'Connection "edge-target-control" cannot connect control output "control-out" to data input "target".',
      correction:
        'Connect ports of the same kind; control ports connect only to control ports.',
    });

    const typeMismatch = completeWorkflow();
    typeMismatch.edges = typeMismatch.edges.filter((edge) => edge.id !== 'edge-target-data');
    typeMismatch.edges.push({
      id: 'edge-type-mismatch',
      source: 'comparison-1',
      sourcePort: 'ranking',
      target: 'generator-1',
      targetPort: 'target',
    });

    const typeResult = validateWorkflow(typeMismatch, manifests);
    expect(typeResult.diagnostics).toContainEqual({
      severity: 'error',
      code: 'INVALID_CONNECTION',
      nodeId: 'generator-1',
      edgeId: 'edge-type-mismatch',
      path: 'edges.3.targetPort',
      message:
        'Connection "edge-type-mismatch" cannot connect "candidate-set" to "target-structure".',
      correction: 'Connect an output with data type "target-structure" to "target" on "Candidate generation".',
    });
  });

  it('reports duplicate connections into one input port', () => {
    const workflow = completeWorkflow();
    workflow.edges.push({
      id: 'edge-target-data-again',
      source: 'target-1',
      sourcePort: 'target',
      target: 'generator-1',
      targetPort: 'target',
    });

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'DUPLICATE_INPUT',
      nodeId: 'generator-1',
      edgeId: 'edge-target-data-again',
      path: 'edges.4.targetPort',
      message:
        'Input "target" on Node "Candidate generation" is connected more than once.',
      correction: 'Keep exactly one connection into "target" on "Candidate generation".',
    });
  });

  it('reports a Node whose Manifest version is not installed', () => {
    const workflow = completeWorkflow();
    workflow.nodes[1] = { ...workflow.nodes[1], manifestVersion: '9.9.9' };

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'UNKNOWN_MANIFEST',
      nodeId: 'generator-1',
      path: 'nodes.1.manifestId',
      message:
        'Node "Candidate generation" references Manifest "candidate-generation@9.9.9", which is not installed.',
      correction:
        'Install "candidate-generation@9.9.9" or change the Node to an installed Manifest version.',
    });
  });

  it('reports dependencies whose source or target Node is missing', () => {
    const workflow = completeWorkflow();
    workflow.edges.push({
      id: 'edge-dangling',
      source: 'generator-1',
      sourcePort: 'candidates',
      target: 'missing-node',
      targetPort: 'scored',
    });

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'UNSATISFIED_DEPENDENCY',
      edgeId: 'edge-dangling',
      path: 'edges.4.target',
      message:
        'Connection "edge-dangling" targets Node "missing-node", which is not in the Workflow.',
      correction: 'Remove the connection or restore the missing target Node.',
    });
  });

  it('reports feedback cycles and self dependencies as impossible execution order', () => {
    const cyclic: WorkflowIR = {
      version: 1,
      nodes: [
        generatorNode(),
        { ...generatorNode(), id: 'generator-2', label: 'Candidate generation 2' },
      ],
      edges: [
        {
          id: 'cycle-a',
          source: 'generator-1',
          sourcePort: 'control-out',
          target: 'generator-2',
          targetPort: 'control-in',
        },
        {
          id: 'cycle-b',
          source: 'generator-2',
          sourcePort: 'control-out',
          target: 'generator-1',
          targetPort: 'control-in',
        },
      ],
    };

    const cycle = validateWorkflow(cyclic, manifests).diagnostics.find(
      (diagnostic) => diagnostic.code === 'CYCLE',
    );
    expect(cycle).toMatchObject({
      severity: 'error',
      code: 'CYCLE',
      path: 'edges',
      correction: 'Remove one connection in the cycle so execution order is well defined.',
    });
    expect(['generator-1', 'generator-2']).toContain(cycle?.nodeId);
    expect(cycle?.message).toContain('dependency cycle');

    const selfLoop = validateWorkflow(
      {
        version: 1,
        nodes: [generatorNode()],
        edges: [
          {
            id: 'self',
            source: 'generator-1',
            sourcePort: 'control-out',
            target: 'generator-1',
            targetPort: 'control-in',
          },
        ],
      },
      manifests,
    ).diagnostics.find((diagnostic) => diagnostic.code === 'CYCLE');
    expect(selfLoop).toMatchObject({ nodeId: 'generator-1', edgeId: 'self' });
  });

  it('reports parameter values that violate the Manifest schema', () => {
    const workflow = completeWorkflow();
    workflow.nodes[1] = {
      ...workflow.nodes[1],
      parameters: { numCandidates: 0, seed: 42 },
    };

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'PARAMETER_ERROR',
      nodeId: 'generator-1',
      path: 'nodes.1.parameters.numCandidates',
      message:
        'Node "Candidate generation" has an invalid parameter: Candidate count must be at least 1.',
      correction:
        'Correct parameter "numCandidates" on Node "Candidate generation" to match its Manifest declaration.',
    });

    const missingRequired = validateWorkflow(
      {
        ...completeWorkflow(),
        nodes: [
          { ...targetNode(), parameters: { targetChain: 'A' } },
          generatorNode(),
          comparisonNode(),
        ],
      },
      manifests,
    );
    const parameterError = missingRequired.diagnostics.find(
      (diagnostic) =>
        diagnostic.code === 'PARAMETER_ERROR' &&
        diagnostic.nodeId === 'target-1',
    );
    expect(parameterError?.message).toContain('Target file is required.');
  });

  it('reports resource declarations that cannot be scheduled', () => {
    const workflow = completeWorkflow();
    workflow.nodes[1] = {
      ...workflow.nodes[1],
      resources: { gpuType: 'A100' },
    };

    const result = validateWorkflow(workflow, manifests);

    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'RESOURCE_ERROR',
      nodeId: 'generator-1',
      path: 'nodes.1.resources.gpuType',
      message:
        'Node "Candidate generation" declares GPU type "A100" without requesting a GPU.',
      correction:
        'Set a GPU count above 0 on Node "Candidate generation" or remove the GPU type.',
    });
  });

  it('classifies schema-invalid parameters and resources by the affected Node', () => {
    const invalidResources = {
      ...completeWorkflow(),
      nodes: [
        targetNode(),
        { ...generatorNode(), resources: { cpu: -2 } },
        comparisonNode(),
      ],
    };
    const resourceResult = validateWorkflow(invalidResources, manifests);
    expect(resourceResult.valid).toBe(false);
    expect(resourceResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'RESOURCE_ERROR',
        nodeId: 'generator-1',
        path: 'nodes.1.resources.cpu',
      }),
    );

    const invalidParameters = {
      ...completeWorkflow(),
      nodes: [
        targetNode(),
        { ...generatorNode(), parameters: 'not-an-object' },
        comparisonNode(),
      ],
    };
    expect(
      validateWorkflow(invalidParameters, manifests).diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: 'PARAMETER_ERROR',
        nodeId: 'generator-1',
        path: 'nodes.1.parameters',
      }),
    );

    expect(
      validateWorkflow({ version: 1, nodes: [], edges: [], layout: {} }, manifests)
        .diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: 'INVALID_WORKFLOW', path: 'layout' }),
    );
  });

  it('reports the Binder outputs that a Workflow cannot produce', () => {
    const withoutComparison = completeWorkflow();
    withoutComparison.edges = withoutComparison.edges.filter(
      (edge) => edge.source !== 'comparison-1' && edge.target !== 'comparison-1',
    );
    withoutComparison.nodes = withoutComparison.nodes.filter(
      (node) => node.id !== 'comparison-1',
    );

    const result = validateWorkflow(withoutComparison, manifests);

    expect(result.valid).toBe(false);
    const missingOutputs = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'MISSING_BINDER_OUTPUT',
    );
    expect(missingOutputs).toHaveLength(2);
    expect(missingOutputs).toContainEqual({
      severity: 'error',
      code: 'MISSING_BINDER_OUTPUT',
      nodeId: 'generator-1',
      path: 'workflow.outputs',
      message:
        'The Workflow does not produce the required Binder output "Ranked candidates" because no Node with Manifest "candidate-comparison" is present.',
      correction:
        'Insert a Candidate comparison Node and connect the scored candidate set into it.',
    });
    expect(missingOutputs.map((diagnostic) => diagnostic.message)).toContain(
      'The Workflow does not produce the required Binder output "Comparison report" because no Node with Manifest "candidate-comparison" is present.',
    );

    const empty = validateWorkflow(
      { version: 1, nodes: [], edges: [] },
      manifests,
    );
    expect(empty.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MISSING_BINDER_OUTPUT' }),
    );
    expect(empty.diagnostics.every((diagnostic) => diagnostic.nodeId === undefined)).toBe(true);
  });

  it('lets a non-Binder caller opt out of the Binder output policy', () => {
    const partial = completeWorkflow();
    partial.edges = partial.edges.filter(
      (edge) => edge.source !== 'comparison-1' && edge.target !== 'comparison-1',
    );
    partial.nodes = partial.nodes.filter((node) => node.id !== 'comparison-1');

    expect(
      validateWorkflow(partial, manifests, { requiredOutputs: [] }),
    ).toEqual({ valid: true, diagnostics: [] });
  });
});
