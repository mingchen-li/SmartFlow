import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CandidateSetSchema,
  ComparisonReportSchema,
  NodeExecutionError,
  TargetStructureSchema,
  defaultParameters,
  type CandidateSet,
  type NodeImplementation,
  type NodeRunContext,
  type NodeRunResult,
} from '@sflow/domain';
import {
  builtinManifests,
  builtinNodeImplementation,
  builtinNodeImplementations,
  createBuiltinNodeRegistry,
} from '@sflow/nodes';

const tempRoots: string[] = [];

afterEach(() => {
  // Temp roots are tiny and the OS cleans them up; keeping cleanup explicit
  // avoids leaking test artifacts between runs.
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

interface HarnessOptions {
  projectFiles?: Record<string, string>;
  taskId?: string;
  runId?: string;
}

interface Harness {
  projectRoot: string;
  outputDir: string;
  logs: string[];
  context: NodeRunContext;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sflow-nodes-'));
  tempRoots.push(projectRoot);
  for (const [path, contents] of Object.entries(options.projectFiles ?? {})) {
    const absolute = join(projectRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  const outputDir = join(
    projectRoot,
    '.sflow',
    'runs',
    options.runId ?? 'run-1',
    'tasks',
    options.taskId ?? 'task-1',
  );
  mkdirSync(outputDir, { recursive: true });

  const logs: string[] = [];
  const context: NodeRunContext = {
    runId: options.runId ?? 'run-1',
    taskId: options.taskId ?? 'task-1',
    nodeId: 'node',
    attempt: 1,
    outputDir,
    signal: new AbortController().signal,
    log: (line) => logs.push(line),
    writeFile(relativePath, contents) {
      const absolute = join(outputDir, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents, { flag: 'wx' });
      return absolute;
    },
    readProjectFile(projectRelativePath) {
      try {
        return readFileSync(join(projectRoot, projectRelativePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  };

  return { projectRoot, outputDir, logs, context };
}

function implementation(id: string): NodeImplementation {
  const found = builtinNodeImplementation(id);
  if (!found) throw new Error(`Missing implementation ${id}`);
  return found;
}

function defaults(id: string): Record<string, unknown> {
  return defaultParameters(implementation(id).manifest);
}

function runNode(
  id: string,
  input: Record<string, unknown>,
  params: Record<string, unknown>,
  harness: Harness,
): NodeRunResult {
  const result = implementation(id).run(input, params, harness.context);
  if (result instanceof Promise) throw new Error('Built-in Nodes must run synchronously.');
  return result;
}

function readJson<T>(harness: Harness, relativePath: string): T {
  return JSON.parse(readFileSync(join(harness.outputDir, relativePath), 'utf8')) as T;
}

const PDB_TARGET = [
  'HEADER TARGET',
  'ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N',
  'ATOM      2  CA  ALA A   1      12.560   6.134  -6.504  1.00  0.00           C',
  'ATOM      3  N   GLY A   2      13.104   7.134  -6.504  1.00  0.00           N',
  'END',
].join('\n');

function workflowInputs(): {
  target: unknown;
  candidates: CandidateSet;
  designs: CandidateSet;
  scored: CandidateSet;
} {
  const projectHarness = makeHarness({
    projectFiles: {
      'target.pdb': PDB_TARGET,
      'target.fasta': '>target\nMKTAYIAKQRQISFVKSHFSRQDILDLWQ\n',
    },
  });
  const targetParams = {
    ...defaults('target-input'),
    targetFile: { fileReferenceId: 'file-1', path: 'target.pdb', name: 'target.pdb' },
    targetChain: 'A',
  };
  const target = runNode('target-input', {}, targetParams, projectHarness);
  const targetValue = target.outputs.find((output) => output.portId === 'target')?.value;

  const generationParams = {
    ...defaults('candidate-generation'),
    numCandidates: 6,
    seed: 42,
    strategy: 'cdr-focused',
  };
  const generation = runNode(
    'candidate-generation',
    { target: targetValue },
    generationParams,
    makeHarness({ projectFiles: {} }),
  );
  const candidates = generation.outputs.find(
    (output) => output.portId === 'candidates',
  )?.value as CandidateSet;

  const designParams = {
    ...defaults('sequence-design'),
    numDesigns: 4,
    randomSeed: 7,
    model: 'vhh-designer-v1',
    temperature: 0.7,
  };
  const designHarness = makeHarness();
  const design = runNode(
    'sequence-design',
    { candidates },
    designParams,
    designHarness,
  );
  const designs = design.outputs.find((output) => output.portId === 'designs')
    ?.value as CandidateSet;

  const predictionParams = {
    ...defaults('structure-prediction'),
    predictor: 'esmfold2',
    seed: 1,
  };
  const predictionHarness = makeHarness();
  const prediction = runNode(
    'structure-prediction',
    { designs },
    predictionParams,
    predictionHarness,
  );
  const scored = prediction.outputs.find((output) => output.portId === 'scored')
    ?.value as CandidateSet;

  return { target: targetValue, candidates, designs, scored };
}

describe('built-in deterministic Node implementations', () => {
  it('registers a run implementation for every built-in Manifest version', () => {
    expect(builtinNodeImplementations).toHaveLength(5);
    expect(builtinNodeImplementations.map((impl) => impl.manifest.id)).toEqual(
      builtinManifests.map((manifest) => manifest.id),
    );
    for (const manifest of builtinManifests) {
      expect(createBuiltinNodeRegistry().get(manifest.id, manifest.version)?.manifest).toEqual(
        manifest,
      );
    }
    expect(createBuiltinNodeRegistry().get('candidate-generation', '9.9.9')).toBeUndefined();
  });

  it('loads the path-backed target file and produces a real target Artifact', () => {
    const harness = makeHarness({ projectFiles: { 'target.pdb': PDB_TARGET } });
    const result = runNode(
      'target-input',
      {},
      {
        ...defaults('target-input'),
        targetFile: { fileReferenceId: 'file-1', path: 'target.pdb', name: 'target.pdb' },
        targetChain: 'A',
        hotspotResidues: '2, 75',
      },
      harness,
    );

    const output = result.outputs.find((item) => item.portId === 'target');
    expect(output?.artifacts?.map((artifact) => artifact.name)).toEqual(['target.json']);
    const target = TargetStructureSchema.parse(output?.value);
    expect(target).toMatchObject({
      chain: 'A',
      residueCount: 2,
      hotspots: [2, 75],
      source: { path: 'target.pdb', fileReferenceId: 'file-1' },
    });
    expect(readJson(harness, 'target.json')).toEqual(target);
    expect(result.metrics).toEqual({ targetResidueCount: 2 });
  });

  it('fails when the path-backed target file is missing', () => {
    const harness = makeHarness();
    expect(() =>
      runNode(
        'target-input',
        {},
        {
          ...defaults('target-input'),
          targetFile: { fileReferenceId: 'file-1', path: 'missing.pdb' },
        },
        harness,
      ),
    ).toThrow(/missing\.pdb/);
  });

  it('classifies parameter and input errors as non-retryable Node failures', () => {
    const harness = makeHarness();
    const capture = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      throw new Error('Expected the Node implementation to throw.');
    };

    const parameterFailure = capture(() =>
      runNode(
        'candidate-generation',
        {},
        { ...defaults('candidate-generation'), numCandidates: 0 },
        harness,
      ),
    );
    expect(parameterFailure).toBeInstanceOf(NodeExecutionError);
    expect((parameterFailure as NodeExecutionError).failureKind).toBe('parameter');

    const inputFailure = capture(() =>
      runNode('sequence-design', {}, defaults('sequence-design'), harness),
    );
    expect(inputFailure).toBeInstanceOf(NodeExecutionError);
    expect((inputFailure as NodeExecutionError).failureKind).toBe('validation');

    const missingFile = capture(() =>
      runNode(
        'target-input',
        {},
        {
          ...defaults('target-input'),
          targetFile: { fileReferenceId: 'file-1', path: 'missing.pdb' },
        },
        harness,
      ),
    );
    expect(missingFile).toBeInstanceOf(NodeExecutionError);
    expect((missingFile as NodeExecutionError).failureKind).toBe('validation');
  });

  it('generates deterministic CandidateSets for a given seed and different ones for another seed', () => {
    const first = makeHarness({ taskId: 'task-a' });
    const second = makeHarness({ taskId: 'task-b' });
    const params = {
      ...defaults('candidate-generation'),
      numCandidates: 8,
      seed: 42,
      strategy: 'cdr-focused',
      useTargetHotspots: true,
    };

    const firstResult = runNode('candidate-generation', {}, params, first);
    const secondResult = runNode('candidate-generation', {}, params, second);
    const candidates = CandidateSetSchema.parse(
      firstResult.outputs.find((item) => item.portId === 'candidates')?.value,
    );

    expect(candidates.candidates).toHaveLength(8);
    expect(new Set(candidates.candidates.map((candidate) => candidate.id)).size).toBe(8);
    expect(new Set(candidates.candidates.map((candidate) => candidate.sequence)).size).toBe(8);
    expect(candidates.context).toMatchObject({ strategy: 'cdr-focused', seed: 42 });
    expect(firstResult.metrics).toEqual({ candidateCount: 8, uniqueCandidates: 8 });

    // Same seed and parameters produce byte-identical files, independent of
    // Run/Task identity.
    expect(readFileSync(join(first.outputDir, 'candidates.json'), 'utf8')).toBe(
      readFileSync(join(second.outputDir, 'candidates.json'), 'utf8'),
    );
    expect(readFileSync(join(first.outputDir, 'candidates.fasta'), 'utf8')).toBe(
      readFileSync(join(second.outputDir, 'candidates.fasta'), 'utf8'),
    );

    const different = runNode(
      'candidate-generation',
      {},
      { ...params, seed: 43 },
      makeHarness({ taskId: 'task-c' }),
    );
    expect(
      CandidateSetSchema.parse(
        different.outputs.find((item) => item.portId === 'candidates')?.value,
      ).candidates.map((candidate) => candidate.sequence),
    ).not.toEqual(candidates.candidates.map((candidate) => candidate.sequence));
  });

  it('designs sequences from an input CandidateSet and writes deterministic design files', () => {
    const { candidates } = workflowInputs();
    const harness = makeHarness();
    const params = {
      ...defaults('sequence-design'),
      numDesigns: 4,
      randomSeed: 7,
      model: 'vhh-designer-v1',
      temperature: 0.7,
      trimTerminalTags: true,
    };

    const result = runNode('sequence-design', { candidates }, params, harness);
    const designs = CandidateSetSchema.parse(
      result.outputs.find((item) => item.portId === 'designs')?.value,
    );

    expect(designs.candidates).toHaveLength(4);
    expect(designs.context).toMatchObject({
      strategy: 'vhh-designer-v1',
      seed: 7,
      model: 'vhh-designer-v1',
      sourceCandidateSetId: candidates.id,
    });
    for (const design of designs.candidates) {
      expect(design.generation).toBe('designed');
      expect(candidates.candidates.some((candidate) => candidate.id === design.parentId)).toBe(
        true,
      );
    }
    expect(result.metrics?.designCount).toBe(4);
    expect(result.metrics?.meanConfidence).toBeGreaterThanOrEqual(0);
    expect(result.metrics?.meanConfidence).toBeLessThanOrEqual(1);
    expect(readFileSync(join(harness.outputDir, 'designs.fasta'), 'utf8')).toContain(
      '>design-',
    );
  });

  it('predicts deterministic structures and scores every designed candidate', () => {
    const { designs } = workflowInputs();
    const harness = makeHarness();
    const params = {
      ...defaults('structure-prediction'),
      predictor: 'esmfold2',
      recycles: 3,
      batchSize: 2,
      seed: 1,
    };

    const first = runNode('structure-prediction', { designs }, params, harness);
    const scored = CandidateSetSchema.parse(
      first.outputs.find((item) => item.portId === 'scored')?.value,
    );
    const structures = first.outputs.find((item) => item.portId === 'structures');

    expect(scored.candidates).toHaveLength(designs.candidates.length);
    expect(scored.scores).toHaveLength(designs.candidates.length * 2);
    for (const score of scored.scores) {
      if (score.metricId === 'plddt') {
        expect(score.value).toBeGreaterThanOrEqual(0);
        expect(score.value).toBeLessThanOrEqual(100);
      } else {
        expect(score.value).toBeGreaterThanOrEqual(0);
        expect(score.value).toBeLessThanOrEqual(1);
      }
    }
    expect(structures?.artifacts).toHaveLength(designs.candidates.length);
    for (const artifact of structures?.artifacts ?? []) {
      expect(readFileSync(join(harness.outputDir, artifact.relativePath), 'utf8')).toContain(
        'ATOM',
      );
    }
    expect(readFileSync(join(harness.outputDir, 'scores.csv'), 'utf8')).toContain(
      'candidateId,sequence,plddt,iptm,binding-score',
    );
    expect(first.metrics?.scoredCount).toBe(designs.candidates.length);
    expect(first.metrics?.meanPlddt).toBeGreaterThan(0);

    // Re-running the same Task yields byte-identical structure output.
    const replayHarness = makeHarness({ taskId: 'task-replay' });
    const replay = runNode('structure-prediction', { designs }, params, replayHarness);
    const replayScored = replay.outputs.find((item) => item.portId === 'scored');
    expect(readFileSync(join(replayHarness.outputDir, 'scores.csv'), 'utf8')).toBe(
      readFileSync(join(harness.outputDir, 'scores.csv'), 'utf8'),
    );
    expect(
      CandidateSetSchema.parse(replayScored?.value).scores,
    ).toEqual(scored.scores);
  });

  it('ranks and deduplicates scored candidates and writes a typed comparison report', () => {
    const { designs } = workflowInputs();
    const predictionHarness = makeHarness();
    const prediction = runNode(
      'structure-prediction',
      { designs },
      { ...defaults('structure-prediction'), seed: 1 },
      predictionHarness,
    );
    const scored = CandidateSetSchema.parse(
      prediction.outputs.find((item) => item.portId === 'scored')?.value,
    );

    const harness = makeHarness();
    const params = {
      ...defaults('candidate-comparison'),
      topN: 3,
      rankingMetric: 'plddt',
      deduplicate: true,
      label: 'round-1',
    };
    const result = runNode('candidate-comparison', { scored }, params, harness);

    const ranking = CandidateSetSchema.parse(
      result.outputs.find((item) => item.portId === 'ranking')?.value,
    );
    const report = ComparisonReportSchema.parse(
      result.outputs.find((item) => item.portId === 'report')?.value,
    );

    expect(ranking.candidates).toHaveLength(3);
    expect(report.label).toBe('round-1');
    expect(report.rankingMetric).toBe('plddt');
    expect(report.selectedCount).toBe(3);
    expect(report.entries.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    for (let index = 1; index < report.entries.length; index += 1) {
      expect(report.entries[index - 1].score).toBeGreaterThanOrEqual(
        report.entries[index].score,
      );
    }
    expect(result.metrics?.selectedCount).toBe(3);
    expect(result.metrics?.bestPlddt).toBe(report.bestScore);
    expect(readJson(harness, 'report.json')).toEqual(report);
    expect(readJson(harness, 'ranking.json')).toEqual(ranking);
  });

  it('runs the complete Binder chain with production-shaped data flow', () => {
    const { target, candidates, designs, scored } = workflowInputs();
    expect(TargetStructureSchema.parse(target).residueCount).toBe(2);
    expect(candidates.candidates.length).toBe(6);
    expect(designs.candidates.length).toBe(4);
    expect(scored.scores.length).toBe(8);
  });
});
