import { describe, expect, it } from 'vitest';
import { JsonPatchError, applyJsonPatch, type JsonPatchOperation } from '../src';

interface Sample {
  version: number;
  name?: string;
  nodes: Array<{ id: string; label: string; parameters: Record<string, unknown> }>;
  edges: Array<{ id: string; source: string }>;
}

function sample(): Sample {
  return {
    version: 1,
    nodes: [
      { id: 'a', label: 'Target input', parameters: { chain: 'A' } },
      { id: 'b', label: 'Candidates', parameters: { count: 100 } },
    ],
    edges: [{ id: 'e1', source: 'a' }],
  };
}

function apply(document: unknown, operations: JsonPatchOperation[]): unknown {
  return applyJsonPatch(document, operations).result;
}

describe('RFC 6902 JSON Patch', () => {
  it('adds, replaces, and removes values in objects and arrays', () => {
    const result = apply(sample(), [
      { op: 'replace', path: '/nodes/1/parameters/count', value: 250 },
      { op: 'add', path: '/nodes/1/parameters/seed', value: 7 },
      { op: 'add', path: '/nodes/-', value: { id: 'c', label: 'Score', parameters: {} } },
      { op: 'remove', path: '/edges/0' },
      { op: 'add', path: '/name', value: 'Binder design' },
    ]) as Sample;

    expect(result).toEqual({
      version: 1,
      name: 'Binder design',
      nodes: [
        { id: 'a', label: 'Target input', parameters: { chain: 'A' } },
        { id: 'b', label: 'Candidates', parameters: { count: 250, seed: 7 } },
        { id: 'c', label: 'Score', parameters: {} },
      ],
      edges: [],
    });
    // The input document is never mutated.
    expect(sample().nodes[1].parameters.count).toBe(100);
  });

  it('supports move, copy, and test operations and escaped pointer segments', () => {
    const document = {
      'a/b': 1,
      'm~n': { value: 'old' },
      list: ['first', 'second'],
    };

    const result = apply(document, [
      { op: 'test', path: '/a~1b', value: 1 },
      { op: 'copy', from: '/list/0', path: '/copied' },
      { op: 'move', from: '/m~0n/value', path: '/list/1' },
      { op: 'add', path: '/m~0n/value', value: 'new' },
    ]);

    expect(result).toEqual({
      'a/b': 1,
      'm~n': { value: 'new' },
      list: ['first', 'old', 'second'],
      copied: 'first',
    });
  });

  it('rejects missing paths, invalid array indexes, and failed tests with a path and operation index', () => {
    const cases: Array<{ operation: JsonPatchOperation; code: string; path: string }> = [
      { operation: { op: 'remove', path: '/missing' }, code: 'PATH_NOT_FOUND', path: '/missing' },
      { operation: { op: 'replace', path: '/nodes/9/label', value: 'x' }, code: 'PATH_NOT_FOUND', path: '/nodes/9/label' },
      { operation: { op: 'add', path: '/nodes/5', value: {} }, code: 'PATH_NOT_FOUND', path: '/nodes/5' },
      { operation: { op: 'add', path: 'nodes/-', value: {} }, code: 'INVALID_PATH', path: 'nodes/-' },
      { operation: { op: 'test', path: '/version', value: 2 }, code: 'TEST_FAILED', path: '/version' },
      { operation: { op: 'move', from: '/nodes/0', path: '/nodes/0/id' }, code: 'INVALID_OPERATION', path: '/nodes/0/id' },
    ];

    for (const { operation, code, path } of cases) {
      let caught: unknown;
      try {
        applyJsonPatch(sample(), [{ op: 'test', path: '/version', value: 1 }, operation]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(JsonPatchError);
      const patchError = caught as JsonPatchError;
      expect(patchError.code).toBe(code);
      expect(patchError.path).toBe(path);
      expect(patchError.operationIndex).toBe(1);
    }
  });

  it('generates inverse operations that restore the prior document', () => {
    const document = sample();
    const { result, inverse } = applyJsonPatch(document, [
      { op: 'replace', path: '/nodes/1/parameters/count', value: 250 },
      { op: 'add', path: '/nodes/1/parameters/seed', value: 7 },
      { op: 'remove', path: '/edges/0' },
      { op: 'add', path: '/nodes/2', value: { id: 'c', label: 'Score', parameters: {} } },
      { op: 'move', from: '/nodes/0/label', path: '/nodes/2/label' },
      { op: 'copy', from: '/version', path: '/copiedVersion' },
    ]);

    const restored = applyJsonPatch(result, inverse).result;
    expect(restored).toEqual(document);
  });
});
