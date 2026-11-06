import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SLURM_TASK_INPUT_VERSION,
  CandidateSetSchema,
  type CandidateSet,
} from '@sflow/domain';
import { runProductionStructurePredictionContainer } from '../src';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const DESIGNS: CandidateSet = CandidateSetSchema.parse({
  id: 'design-set:container',
  name: 'Designed sequences',
  candidates: [
    {
      id: 'design-0001',
      sequence: 'QVQLVESGGGLVQAGGSLRLSCAASGFTFSSYAMSWVRQAPGKEREFVA',
      generation: 'designed',
      parentId: 'candidate-0001',
    },
  ],
  metricValues: [],
  context: { strategy: 'vhh-designer-v1', seed: 7 },
});

function taskInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: SLURM_TASK_INPUT_VERSION,
    runId: 'run-1',
    taskId: 'task-4',
    nodeId: 'node-predictor',
    attempt: 1,
    manifestId: 'structure-prediction',
    manifestVersion: '2.0.0',
    parameters: { predictor: 'esmfold2', recycles: 3, batchSize: 4, seed: 1 },
    fileReferences: [],
    inputs: { designs: DESIGNS, 'control-in': true },
    resources: { cpu: 8, memory: '48Gi', gpu: 1, gpuType: 'A100', walltimeMinutes: 180 },
    ...overrides,
  };
}

describe('production structure-prediction container entrypoint', () => {
  it('writes the ticket #12 result contract and content-addressed output files', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'sflow-prod-container-'));
    roots.push(taskDir);
    const taskInputPath = join(taskDir, 'task-input.json');
    writeFileSync(taskInputPath, JSON.stringify(taskInput()));
    const logs: string[] = [];

    await runProductionStructurePredictionContainer({
      taskDir,
      taskInputPath,
      resultPath: join(taskDir, 'result.json'),
      log: (line) => logs.push(line),
    });

    const result = JSON.parse(readFileSync(join(taskDir, 'result.json'), 'utf8')) as {
      outputs: Array<{
        portId: string;
        value?: unknown;
        artifacts: Array<{
          name: string;
          relativePath: string;
          mediaType: string;
          schema?: unknown;
          sha256: string;
          size: number;
        }>;
      }>;
      metrics: Array<{
        spec: { id: string };
        value: unknown;
        schema: { namespace: string; name: string; version: string };
      }>;
    };

    expect(result.outputs.map((output) => output.portId)).toEqual([
      'scored',
      'structures',
    ]);
    expect(result.outputs[0].value).toBeDefined();
    expect(result.outputs[0].artifacts.map((artifact) => artifact.name)).toEqual([
      'scored.json',
      'scores.csv',
    ]);
    expect(result.outputs[0].artifacts[0].schema).toEqual({
      namespace: 'sflow.binder',
      name: 'candidate-set',
      version: '1.0.0',
    });
    expect(result.outputs[1].artifacts).toHaveLength(1);

    for (const artifact of result.outputs.flatMap((output) => output.artifacts)) {
      const bytes = readFileSync(join(taskDir, artifact.relativePath));
      expect(artifact.size).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }

    expect(result.metrics.map((metric) => metric.spec.id)).toEqual([
      'meanPlddt',
      'meanIptm',
      'scoredCount',
    ]);
    for (const metric of result.metrics) {
      expect(metric.schema).toEqual({
        namespace: 'sflow.binder.structure-prediction',
        name: metric.spec.id,
        version: '2.0.0',
      });
    }

    expect(logs.join('\n')).toContain('structure-prediction-production');
    expect(logs.join('\n')).toContain('manifest=structure-prediction@2.0.0');
  });

  it('fails with a diagnosable model packaging error when the task input targets another Manifest version', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'sflow-prod-container-bad-'));
    roots.push(taskDir);
    const taskInputPath = join(taskDir, 'task-input.json');
    writeFileSync(taskInputPath, JSON.stringify(taskInput({ manifestVersion: '1.0.0' })));

    await expect(
      runProductionStructurePredictionContainer({
        taskDir,
        taskInputPath,
        resultPath: join(taskDir, 'result.json'),
      }),
    ).rejects.toThrow(/structure-prediction@2\.0\.0/);
  });

  it('fails with a diagnosable model input error when the designs payload is invalid', async () => {
    const taskDir = mkdtempSync(join(tmpdir(), 'sflow-prod-container-input-'));
    roots.push(taskDir);
    const taskInputPath = join(taskDir, 'task-input.json');
    writeFileSync(
      taskInputPath,
      JSON.stringify(taskInput({ inputs: { designs: { nope: true } } })),
    );

    await expect(
      runProductionStructurePredictionContainer({
        taskDir,
        taskInputPath,
        resultPath: join(taskDir, 'result.json'),
      }),
    ).rejects.toThrow(/CandidateSet/);
  });
});
