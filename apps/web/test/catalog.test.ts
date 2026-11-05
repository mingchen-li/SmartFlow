import { describe, expect, it } from 'vitest';
import { builtinManifests } from '@sflow/nodes';
import { buildCatalog, filterCatalog } from '../src/editor/catalog';

describe('Node Library catalog', () => {
  it('groups Manifests by category with computed counts', () => {
    expect(buildCatalog(builtinManifests)).toEqual([
      { id: 'all', label: 'All nodes', count: 5 },
      { id: 'inputs', label: 'Inputs', count: 1 },
      { id: 'protein-design', label: 'Protein design', count: 2 },
      { id: 'structure-prediction', label: 'Structure prediction', count: 1 },
      { id: 'analysis', label: 'Analysis', count: 1 },
    ]);
  });

  it('shows every Manifest from the All nodes category', () => {
    expect(filterCatalog(builtinManifests, 'all', '')).toHaveLength(5);
  });

  it('searches name, description, type, category, and Manifest id', () => {
    expect(filterCatalog(builtinManifests, 'all', 'Candidate generation').map((m) => m.id)).toEqual(
      ['candidate-generation'],
    );
    expect(filterCatalog(builtinManifests, 'all', 'VHH').map((m) => m.id)).toEqual([
      'sequence-design',
    ]);
    expect(filterCatalog(builtinManifests, 'all', 'predictor').map((m) => m.id)).toEqual([
      'structure-prediction',
    ]);
    expect(filterCatalog(builtinManifests, 'all', 'Inputs').map((m) => m.id)).toEqual([
      'target-input',
    ]);
    expect(filterCatalog(builtinManifests, 'all', 'report').map((m) => m.id)).toEqual([
      'candidate-comparison',
    ]);
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(filterCatalog(builtinManifests, 'all', '  GENERATOR ').map((m) => m.id)).toEqual([
      'candidate-generation',
    ]);
  });

  it('combines the category filter and the query with AND', () => {
    expect(
      filterCatalog(builtinManifests, 'protein-design', '').map((m) => m.id),
    ).toEqual(['candidate-generation', 'sequence-design']);

    expect(
      filterCatalog(builtinManifests, 'protein-design', 'sequence').map((m) => m.id),
    ).toEqual(['sequence-design']);

    expect(filterCatalog(builtinManifests, 'analysis', 'sequence')).toEqual([]);
  });

  it('returns an empty result for unmatched queries', () => {
    expect(filterCatalog(builtinManifests, 'all', 'no such node')).toEqual([]);
  });
});
