import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CandidateSetSchema,
  type CandidateSet,
  type NodeRunContext,
  type NodeRunResult,
} from '@sflow/domain';
import { builtinNodeImplementation } from '@sflow/nodes';
import {
  productionStructurePredictionImplementation,
  runProductionStructurePrediction,
} from '../src';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sflow-prod-predict-'));
  roots.push(dir);
  return dir;
}

function context(taskDir: string, logs: string[]): NodeRunContext {
  return {
    runId: 'run-contract',
    taskId: 'task-contract',
    nodeId: 'node-predictor',
    attempt: 1,
    outputDir: taskDir,
    signal: new AbortController().signal,
    log: (line) => logs.push(line),
    writeFile: (relativePath, contents) => {
      const target = join(taskDir, relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents, { flag: 'wx' });
      return target;
    },
    readProjectFile: () => undefined,
  };
}

const DESIGNS: CandidateSet = CandidateSetSchema.parse({
  id: 'design-set:contract',
  name: 'Designed sequences',
  candidates: [
    {
      id: 'design-0001',
      sequence: 'QVQLVESGGGLVQAGGSLRLSCAASGFTFSSYAMSWVRQAPGKEREFVA',
      generation: 'designed',
      parentId: 'candidate-0001',
    },
    {
      id: 'design-0002',
      sequence: 'QVQLVESGGGLVQAGGSLRLSCAASGFTFSSYAMSWVRQAPGKEREFVD',
      generation: 'designed',
      parentId: 'candidate-0002',
    },
  ],
  scores: [],
  context: { strategy: 'vhh-designer-v1', seed: 7 },
});

const PARAMETERS = { predictor: 'esmfold2', recycles: 3, batchSize: 4, seed: 1 };

/** Artifact identity without byte content, which is compared separately. */
function outputContract(result: NodeRunResult) {
  return result.outputs.map((output) => ({
    portId: output.portId,
    hasValue: output.value !== undefined,
    artifacts: (output.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType,
      schema: artifact.schema,
    })),
  }));
}

describe('production structure-prediction implementation', () => {
  it('fulfils the same ports, artifacts, Metrics, and deterministic outputs as the fixture', async () => {
    const productionDir = tempDir();
    const fixtureDir = tempDir();
    const productionLogs: string[] = [];
    const fixtureLogs: string[] = [];

    const production = await runProductionStructurePrediction(
      { designs: structuredClone(DESIGNS) },
      PARAMETERS,
      context(productionDir, productionLogs),
    );
    const fixtureImplementation = builtinNodeImplementation('structure-prediction', '1.0.0')!;
    const fixture = await fixtureImplementation.run(
      { designs: structuredClone(DESIGNS) },
      PARAMETERS,
      context(fixtureDir, fixtureLogs),
    );

    expect(production.outputs.map((output) => output.portId)).toEqual([
      'scored',
      'structures',
    ]);
    expect(outputContract(production)).toEqual(outputContract(fixture));
    expect(production.metrics).toEqual(fixture.metrics);

    // The deterministic simulation keeps the scientific output stable while
    // the Node implementation is independently packaged and versioned.
    for (const name of ['scored.json', 'scores.csv']) {
      expect(readFileSync(join(productionDir, name), 'utf8')).toBe(
        readFileSync(join(fixtureDir, name), 'utf8'),
      );
    }
    for (const name of ['design-0001.pdb', 'design-0002.pdb']) {
      expect(
        readFileSync(join(productionDir, 'structures', name), 'utf8'),
      ).toBe(readFileSync(join(fixtureDir, 'structures', name), 'utf8'));
    }

    expect(productionLogs.join('\n')).toContain('structure-prediction-production');
  });

  it('is published as a registry implementation at Manifest version 2.0.0', () => {
    expect(productionStructurePredictionImplementation.manifest.version).toBe('2.0.0');
    expect(productionStructurePredictionImplementation.manifest.id).toBe(
      'structure-prediction',
    );
  });
});
