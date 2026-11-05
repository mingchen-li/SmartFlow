import { describe, expect, it } from 'vitest';
import { builtinManifestById } from '@sflow/nodes';
import {
  createNodeInstance,
  defaultNodePosition,
  duplicateNodeInstance,
} from '../src/editor/model';

const sequenceDesign = builtinManifestById('sequence-design')!;
const comparison = builtinManifestById('candidate-comparison')!;

describe('Node instance model', () => {
  it('inserts a configured Node instance from Manifest defaults, never an empty placeholder', () => {
    const first = createNodeInstance(sequenceDesign, []);
    const second = createNodeInstance(sequenceDesign, [first]);

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      manifestId: 'sequence-design',
      manifestVersion: sequenceDesign.version,
      label: 'Sequence design',
      resources: {},
    });
    expect(first.parameters).toEqual({
      model: 'vhh-designer-v1',
      temperature: 0.7,
      numDesigns: 50,
      randomSeed: 7,
      trimTerminalTags: true,
    });
    expect(second.label).toBe('Sequence design 2');
  });

  it('duplicates a Node instance with a new id and copied configuration', () => {
    const source = createNodeInstance(comparison, []);
    source.parameters.topN = 25;
    source.resources = { cpu: 4, memory: '16Gi' };

    const duplicate = duplicateNodeInstance(
      { nodes: [source] },
      source.id,
    );

    expect(duplicate).toBeDefined();
    expect(duplicate!.id).not.toBe(source.id);
    expect(duplicate).toMatchObject({
      manifestId: 'candidate-comparison',
      manifestVersion: comparison.version,
      label: 'Candidate comparison copy',
      parameters: { ...source.parameters },
      resources: { cpu: 4, memory: '16Gi' },
    });

    const secondDuplicate = duplicateNodeInstance(
      { nodes: [source, duplicate!] },
      source.id,
    );
    expect(secondDuplicate!.label).toBe('Candidate comparison copy 2');
    expect(secondDuplicate!.parameters).not.toBe(source.parameters);
  });

  it('returns undefined when the duplicated Node no longer exists', () => {
    expect(
      duplicateNodeInstance({ nodes: [] }, 'gone'),
    ).toBeUndefined();
  });

  it('cascades inserted Node positions without touching Workflow IR', () => {
    expect(defaultNodePosition(0)).toEqual({ x: 80, y: 80 });
    expect(defaultNodePosition(1)).toEqual({ x: 310, y: 80 });
    expect(defaultNodePosition(4)).toEqual({ x: 80, y: 230 });
  });
});
