import { describe, expect, it } from 'vitest';
import {
  AgentPatchProposalRequestSchema,
  AgentPatchSchema,
  describeJsonPatchOperations,
} from '../src';

const WORKFLOW = {
  version: 1,
  nodes: [
    { id: 'node-target', label: 'Target input', parameters: { chain: 'A' } },
    { id: 'node-generator', label: 'Candidates', parameters: { count: 100 } },
  ],
  edges: [{ id: 'edge-1', source: 'node-target' }],
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'workflow',
    target: { kind: 'workflow', workflowId: 'binder-design' },
    baseRevision: 3,
    summary: 'Increase candidate count',
    operations: [
      {
        op: 'replace',
        path: '/nodes/1/parameters/count',
        value: 250,
      },
    ],
    ...overrides,
  };
}

describe('Agent patch contracts', () => {
  it('parses a typed workflow proposal and rejects scope/target mismatches', () => {
    const parsed = AgentPatchProposalRequestSchema.parse(proposal());
    expect(parsed.target).toEqual({ kind: 'workflow', workflowId: 'binder-design' });
    expect(parsed.operations).toHaveLength(1);

    expect(() =>
      AgentPatchProposalRequestSchema.parse(
        proposal({ target: { kind: 'result-view', resultViewId: 'results-1' } }),
      ),
    ).toThrow(/scope/i);

    expect(() =>
      AgentPatchProposalRequestSchema.parse(proposal({ baseRevision: -1 })),
    ).toThrow();
    expect(() =>
      AgentPatchProposalRequestSchema.parse(proposal({ operations: [] })),
    ).toThrow();
    expect(() =>
      AgentPatchProposalRequestSchema.parse(
        proposal({ operations: [{ op: 'replace', path: '/version' }] }),
      ),
    ).toThrow();
    expect(() =>
      AgentPatchProposalRequestSchema.parse(
        proposal({ extra: 'unvalidated direct write' }),
      ),
    ).toThrow();
  });

  it('requires workflow patches to identify the target workflow and allows an optional Node', () => {
    expect(() =>
      AgentPatchProposalRequestSchema.parse(
        proposal({ target: { kind: 'workflow', workflowId: 'binder-design', nodeId: 'node-generator' } }),
      ),
    ).not.toThrow();
    expect(() =>
      AgentPatchProposalRequestSchema.parse(proposal({ target: { kind: 'workflow' } })),
    ).toThrow();
  });

  it('parses a persisted patch with status, validation, and inverse operations', () => {
    const patch = AgentPatchSchema.parse({
      id: 'patch-1',
      workflowId: 'binder-design',
      scope: 'workflow',
      target: { kind: 'workflow', workflowId: 'binder-design' },
      baseRevision: 3,
      resultRevision: null,
      summary: 'Increase candidate count',
      operations: [{ op: 'replace', path: '/nodes/1/parameters/count', value: 250 }],
      inverseOperations: [{ op: 'replace', path: '/nodes/1/parameters/count', value: 100 }],
      status: 'proposed',
      validation: { valid: true, schemaValid: true, semanticValid: true, diagnostics: [] },
      diff: [],
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
      appliedAt: null,
      revertedAt: null,
    });

    expect(patch.status).toBe('proposed');
    expect(patch.resultRevision).toBeNull();
    expect(() =>
      AgentPatchSchema.parse({ ...patch, status: 'pending' }),
    ).toThrow();
  });

  it('describes operations as a human-readable diff alongside the raw operations', () => {
    const diff = describeJsonPatchOperations(WORKFLOW, [
      { op: 'replace', path: '/nodes/1/parameters/count', value: 250 },
      { op: 'add', path: '/nodes/1/parameters/seed', value: 7 },
      { op: 'remove', path: '/edges/0' },
      { op: 'move', from: '/nodes/0/label', path: '/nodes/1/label' },
      { op: 'test', path: '/version', value: 1 },
    ]);

    expect(diff).toHaveLength(5);
    expect(diff[0]).toMatchObject({
      operation: 0,
      op: 'replace',
      path: '/nodes/1/parameters/count',
      before: 100,
      after: 250,
    });
    expect(diff[0].description).toContain('nodes[1].parameters.count');
    expect(diff[0].description).toContain('100');
    expect(diff[0].description).toContain('250');
    expect(diff[1].description).toContain('seed');
    expect(diff[2].description).toContain('edges[0]');
    expect(diff[3].description).toContain('nodes[0].label');
    expect(diff[3].description).toContain('nodes[1].label');
    expect(diff[4].description).toContain('version');
  });
});
