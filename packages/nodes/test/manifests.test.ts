import { describe, expect, it } from 'vitest';
import {
  NodeManifestSchema,
  defaultParameters,
  validateConnection,
  validateParameters,
  type NodeManifest,
  type WorkflowIR,
} from '@sflow/domain';
import { builtinManifests, builtinManifestById } from '@sflow/nodes';

describe('built-in Binder Node Manifests', () => {
  it('ships the five production-shaped Binder steps', () => {
    expect(builtinManifests.map((manifest) => manifest.id)).toEqual([
      'target-input',
      'candidate-generation',
      'sequence-design',
      'structure-prediction',
      'candidate-comparison',
    ]);
    expect(new Set(builtinManifests.map((manifest) => manifest.id)).size).toBe(5);
    expect(new Set(builtinManifests.map((manifest) => manifest.version)).size).toBe(1);
  });

  it('validates every Manifest against the shared domain contract', () => {
    for (const manifest of builtinManifests) {
      expect(NodeManifestSchema.safeParse(manifest).success, manifest.id).toBe(true);
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.description.length).toBeGreaterThan(10);
      expect(manifest.type.length).toBeGreaterThan(0);
      expect(manifest.environment.kind).toBe('container');
      expect(manifest.environment.image).toContain(manifest.id);
      expect(manifest.resources.cpu).toBeGreaterThan(0);
      expect(manifest.retry.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(manifest.metrics.length).toBeGreaterThan(0);
    }
  });

  it('declares navigable categories with descriptions', () => {
    const categories = new Map<string, number>();
    for (const manifest of builtinManifests) {
      categories.set(manifest.category, (categories.get(manifest.category) ?? 0) + 1);
    }

    expect([...categories.entries()]).toEqual([
      ['Inputs', 1],
      ['Protein design', 2],
      ['Structure prediction', 1],
      ['Analysis', 1],
    ]);
  });

  it('declares data and control ports that form a valid Binder chain', () => {
    const nodes: WorkflowIR['nodes'] = builtinManifests.map((manifest) => ({
      id: manifest.id,
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      label: manifest.name,
      parameters: defaultParameters(manifest),
      resources: {},
    }));
    const workflow: WorkflowIR = { version: 1, nodes, edges: [] };

    const dataEdges = [
      ['target-input', 'target', 'candidate-generation', 'target'],
      ['candidate-generation', 'candidates', 'sequence-design', 'candidates'],
      ['sequence-design', 'designs', 'structure-prediction', 'designs'],
      ['structure-prediction', 'scored', 'candidate-comparison', 'scored'],
    ] as const;
    const controlEdges = [
      ['target-input', 'candidate-generation'],
      ['candidate-generation', 'sequence-design'],
      ['sequence-design', 'structure-prediction'],
      ['structure-prediction', 'candidate-comparison'],
    ] as const;

    let edgeCount = 0;
    for (const [source, sourcePort, target, targetPort] of dataEdges) {
      const result = validateConnection(workflow, builtinManifests, {
        source,
        sourcePort,
        target,
        targetPort,
      });
      expect(result, `${source}.${sourcePort} -> ${target}.${targetPort}`).toEqual({
        valid: true,
      });
      workflow.edges.push({
        id: `edge-${edgeCount++}`,
        source,
        sourcePort,
        target,
        targetPort,
      });
    }

    for (const [source, target] of controlEdges) {
      const result = validateConnection(workflow, builtinManifests, {
        source,
        sourcePort: 'control-out',
        target,
        targetPort: 'control-in',
      });
      expect(result, `${source} control -> ${target} control`).toEqual({ valid: true });
      workflow.edges.push({
        id: `edge-${edgeCount++}`,
        source,
        sourcePort: 'control-out',
        target,
        targetPort: 'control-in',
      });
    }

    expect(workflow.edges).toHaveLength(8);
  });

  it('declares the common parameter types so forms can be generated', () => {
    const parameterTypes = new Set(
      builtinManifests.flatMap((manifest) =>
        manifest.parameters.map((parameter) => parameter.type),
      ),
    );

    expect(parameterTypes).toEqual(
      new Set(['string', 'number', 'boolean', 'enum', 'file-reference']),
    );
  });

  it('starts every Node from Manifest defaults, with a File Reference choice for target input', () => {
    for (const manifest of builtinManifests) {
      const defaults = defaultParameters(manifest);
      const issues = validateParameters(manifest, defaults);

      if (manifest.id === 'target-input') {
        expect(issues.map((issue) => issue.path)).toEqual(['targetFile']);

        const configured = validateParameters(manifest, {
          ...defaults,
          targetFile: {
            fileReferenceId: 'reference-1',
            path: 'target.pdb',
            name: 'target.pdb',
          },
        });
        expect(configured).toEqual([]);
      } else {
        expect(issues, manifest.id).toEqual([]);
      }
    }
  });

  it('exposes a lookup by Manifest id', () => {
    expect(builtinManifestById('sequence-design')?.name).toBe('Sequence design');
    expect(builtinManifestById('missing')).toBeUndefined();
  });
});

describe('built-in Manifest metadata', () => {
  const manifests: readonly NodeManifest[] = builtinManifests;

  it('names scientific Metrics with meaning and scale where applicable', () => {
    const structure = manifests.find((manifest) => manifest.id === 'structure-prediction')!;
    expect(structure.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'meanPlddt', unit: 'score', direction: 'higher-is-better' }),
        expect.objectContaining({ id: 'meanIptm', direction: 'higher-is-better' }),
      ]),
    );
  });

  it('declares resource and environment requirements without execution code', () => {
    const design = manifests.find((manifest) => manifest.id === 'sequence-design')!;
    expect(design.resources.gpu).toBeGreaterThanOrEqual(1);
    expect(design.environment.image).toMatch(/sequence-design/);
    expect(design.retry).toMatchObject({ maxAttempts: expect.any(Number) });
  });
});
