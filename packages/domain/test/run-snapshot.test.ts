import { describe, expect, it } from 'vitest';
import {
  CreateRunResponseSchema,
  NodeManifestSchema,
  RunSchema,
  RunSnapshotSchema,
  ValidateWorkflowResponseSchema,
  createRunSnapshot,
  type NodeManifest,
  type WorkflowIR,
} from '../src';

const inputManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'input',
  version: '1.0.0',
  name: 'Input',
  description: 'Select a target file.',
  category: 'Inputs',
  type: 'input',
  inputs: [],
  outputs: [
    { id: 'target', name: 'Target', direction: 'output', kind: 'data', dataType: 'target' },
  ],
  parameters: [
    { id: 'file', name: 'Target file', type: 'file-reference', required: true },
    { id: 'chain', name: 'Chain', type: 'string', default: 'A' },
    { id: 'count', name: 'Count', type: 'number', default: 10, min: 1 },
  ],
  metrics: [],
  resources: { cpu: 1, memory: '2Gi', walltimeMinutes: 10 },
  environment: { kind: 'container', image: 'registry.example/input:1.0.0' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
});

const designManifest: NodeManifest = NodeManifestSchema.parse({
  id: 'design',
  version: '2.0.0',
  name: 'Design',
  description: 'Design candidates.',
  category: 'Protein design',
  type: 'designer',
  inputs: [
    {
      id: 'target',
      name: 'Target',
      direction: 'input',
      kind: 'data',
      dataType: 'target',
      required: true,
    },
  ],
  outputs: [
    {
      id: 'designs',
      name: 'Designs',
      direction: 'output',
      kind: 'data',
      dataType: 'candidate-set',
    },
  ],
  parameters: [
    { id: 'model', name: 'Model', type: 'string', default: 'v1' },
    { id: 'numDesigns', name: 'Design count', type: 'number', default: 50, min: 1 },
  ],
  metrics: [],
  resources: { cpu: 4, memory: '8Gi', gpu: 1, gpuType: 'A100', walltimeMinutes: 60 },
  environment: {
    kind: 'container',
    image: 'registry.example/design:2.0.0',
    command: ['run-design'],
    variables: { MODEL_CACHE: '/models' },
  },
  retry: { maxAttempts: 2, backoffSeconds: 30, retryOn: ['transient', 'timeout'] },
});

const manifests = [inputManifest, designManifest];

function workflow(): WorkflowIR {
  return {
    version: 1,
    id: 'binder-design',
    name: 'Binder design',
    nodes: [
      {
        id: 'input-1',
        manifestId: 'input',
        manifestVersion: '1.0.0',
        label: 'Target input',
        parameters: {
          file: {
            fileReferenceId: 'ref-1',
            path: 'inputs/target.pdb',
            name: 'target.pdb',
          },
          count: 25,
        },
        resources: {},
      },
      {
        id: 'design-1',
        manifestId: 'design',
        manifestVersion: '2.0.0',
        label: 'Sequence design',
        parameters: {},
        resources: { cpu: 8 },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'input-1',
        sourcePort: 'target',
        target: 'design-1',
        targetPort: 'target',
      },
    ],
  };
}

describe('createRunSnapshot', () => {
  it('captures the Workflow IR with resolved parameters, resources, environments, and File References', () => {
    const ir = workflow();
    const snapshot = createRunSnapshot(ir, manifests);

    expect(snapshot).toEqual({
      version: 1,
      workflow: ir,
      nodes: [
        {
          nodeId: 'input-1',
          label: 'Target input',
          manifestId: 'input',
          manifestVersion: '1.0.0',
          parameters: {
            file: {
              fileReferenceId: 'ref-1',
              path: 'inputs/target.pdb',
              name: 'target.pdb',
            },
            chain: 'A',
            count: 25,
          },
          resources: { cpu: 1, memory: '2Gi', walltimeMinutes: 10 },
          environment: { kind: 'container', image: 'registry.example/input:1.0.0' },
          retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
          fileReferences: [
            {
              parameterId: 'file',
              fileReferenceId: 'ref-1',
              path: 'inputs/target.pdb',
              name: 'target.pdb',
            },
          ],
        },
        {
          nodeId: 'design-1',
          label: 'Sequence design',
          manifestId: 'design',
          manifestVersion: '2.0.0',
          parameters: { model: 'v1', numDesigns: 50 },
          resources: {
            cpu: 8,
            memory: '8Gi',
            gpu: 1,
            gpuType: 'A100',
            walltimeMinutes: 60,
          },
          environment: {
            kind: 'container',
            image: 'registry.example/design:2.0.0',
            command: ['run-design'],
            variables: { MODEL_CACHE: '/models' },
          },
          retry: {
            maxAttempts: 2,
            backoffSeconds: 30,
            retryOn: ['transient', 'timeout'],
          },
          fileReferences: [],
        },
      ],
    });
    expect(RunSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('is immutable: later Workflow IR or Manifest edits do not change a captured snapshot', () => {
    const ir = workflow();
    const mutableManifests = manifests.map((manifest) => structuredClone(manifest));
    const snapshot = createRunSnapshot(ir, mutableManifests);

    (ir.nodes[0].parameters as Record<string, unknown>).count = 999;
    ir.nodes[0].label = 'Edited after start';
    mutableManifests[0].resources.cpu = 64;

    expect(snapshot.workflow.nodes[0].label).toBe('Target input');
    expect(snapshot.nodes[0].parameters.count).toBe(25);
    expect(snapshot.nodes[0].resources.cpu).toBe(1);
    expect(snapshot.nodes[0].environment).toEqual({
      kind: 'container',
      image: 'registry.example/input:1.0.0',
    });
  });

  it('contains no EditorLayout, panel, maximize, Agent, library, selection, or viewport state', () => {
    const snapshot = createRunSnapshot(workflow(), manifests);

    expect(Object.keys(snapshot).sort()).toEqual(['nodes', 'version', 'workflow']);
    expect(Object.keys(snapshot.workflow).sort()).toEqual([
      'edges',
      'id',
      'name',
      'nodes',
      'version',
    ]);
    for (const node of snapshot.nodes) {
      expect(Object.keys(node).sort()).toEqual([
        'environment',
        'fileReferences',
        'label',
        'manifestId',
        'manifestVersion',
        'nodeId',
        'parameters',
        'resources',
        'retry',
      ]);
      for (const key of Object.keys(node.environment)) {
        expect(['command', 'image', 'kind', 'variables']).toContain(key);
      }
    }
    for (const node of snapshot.workflow.nodes) {
      expect(Object.keys(node).sort()).toEqual([
        'id',
        'label',
        'manifestId',
        'manifestVersion',
        'parameters',
        'resources',
      ]);
    }

    const serialized = JSON.stringify(snapshot);
    for (const uiState of [
      'positions',
      'viewport',
      'selection',
      'maximize',
      'libraryQuery',
      'libraryCategory',
      'panelWidths',
      'collapsed',
      'agentGeometry',
      'ballPosition',
    ]) {
      expect(serialized).not.toContain(uiState);
    }
  });
});

describe('Run contracts', () => {
  it('validates Run, CreateRun, and validation response shapes', () => {
    const snapshot = createRunSnapshot(workflow(), manifests);
    const run = RunSchema.parse({
      id: 'run-1',
      workflowId: 'binder-design',
      status: 'queued',
      createdAt: '2026-11-06T10:00:00.000Z',
      updatedAt: '2026-11-06T10:00:00.000Z',
      snapshot,
    });
    expect(run.status).toBe('queued');
    expect(run.snapshot).toEqual(snapshot);

    expect(
      CreateRunResponseSchema.safeParse({ run }).success,
    ).toBe(true);
    expect(
      RunSchema.safeParse({ ...run, status: 'pending' }).success,
    ).toBe(false);
    expect(
      RunSchema.safeParse({ ...run, layout: { viewport: {} } }).success,
    ).toBe(false);

    expect(
      ValidateWorkflowResponseSchema.parse({
        valid: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'INVALID_PORT',
            message: 'Port does not exist.',
            nodeId: 'n-1',
            correction: 'Declare the port.',
          },
        ],
      }),
    ).toMatchObject({ valid: false });
    expect(
      ValidateWorkflowResponseSchema.safeParse({
        valid: false,
        diagnostics: [{ severity: 'error', code: 'UNKNOWN_CODE', message: 'x', correction: 'y' }],
      }).success,
    ).toBe(false);
  });
});
