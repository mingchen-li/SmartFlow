import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  NodeExecutionError,
  SLURM_TASK_INPUT_FILE,
  SlurmTaskInputSchema,
  type NodeRunContext,
  type NodeRunResult,
  type SchemaRef,
  type SlurmTaskInput,
} from '@sflow/domain';
import {
  STRUCTURE_PREDICTION_PRODUCTION_VERSION,
  STRUCTURE_PREDICTION_RESULT_FILE,
  structurePredictionProductionManifest,
} from './manifest';
import { runProductionStructurePrediction } from './run';

/**
 * Production container entrypoint for structure prediction (simulated).
 *
 * The real OCI image would read the Slurm executor's Task input file, run the
 * model, write output files into the Task namespace, and finally write the
 * ticket #12 `result.json` contract (outputs plus Metrics with their scientific
 * schema identities). This module performs exactly those steps deterministically
 * so the production path can be exercised with the injected CommandRunner seam
 * and without model weights, Docker, network, or Slurm.
 */

export interface ContainerArtifactFile {
  name: string;
  relativePath: string;
  mediaType: string;
  schema?: SchemaRef;
  sha256: string;
  size: number;
}

export interface ContainerOutput {
  portId: string;
  value?: unknown;
  artifacts: ContainerArtifactFile[];
}

export interface ContainerMetric {
  spec: {
    id: string;
    name: string;
    description?: string;
    valueType: 'number' | 'string' | 'boolean';
    unit?: string;
    scale?: { min?: number; max?: number };
    direction?: 'higher-is-better' | 'lower-is-better' | 'neutral';
  };
  value: number | string | boolean;
  schema: SchemaRef;
}

export interface ContainerTaskResult {
  outputs: ContainerOutput[];
  metrics: ContainerMetric[];
}

export interface ProductionContainerOptions {
  /** Absolute Task namespace directory (the container working directory). */
  taskDir: string;
  /** Task input file written by the Slurm Compute Executor. */
  taskInputPath: string;
  /** Destination for the ticket #12 result contract. */
  resultPath: string;
  /** Writes line-oriented container logs into the scheduler output file. */
  log?: (line: string) => void;
}

const IDENTITY = {
  manifestId: 'structure-prediction',
  manifestVersion: STRUCTURE_PREDICTION_PRODUCTION_VERSION,
} as const;

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function readTaskInput(path: string): SlurmTaskInput {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new NodeExecutionError(
      'validation',
      `Production structure-prediction container could not read Task input "${path}".`,
    );
  }

  const parsed = SlurmTaskInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NodeExecutionError(
      'validation',
      `Production structure-prediction container received an invalid Task input at "${path}": ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  if (
    parsed.data.manifestId !== IDENTITY.manifestId ||
    parsed.data.manifestVersion !== IDENTITY.manifestVersion
  ) {
    throw new NodeExecutionError(
      'validation',
      `Production structure-prediction container expects Manifest "${IDENTITY.manifestId}@${IDENTITY.manifestVersion}", received "${parsed.data.manifestId}@${parsed.data.manifestVersion}".`,
    );
  }
  return parsed.data;
}

function writeTextFile(
  taskDir: string,
  relativePath: string,
  contents: string | Uint8Array,
): string {
  if (isAbsolute(relativePath)) {
    throw new NodeExecutionError(
      'validation',
      'Production structure prediction may only write inside the Task namespace.',
    );
  }
  const root = resolve(taskDir);
  const absolute = resolve(root, relativePath);
  if (!isInside(root, absolute)) {
    throw new NodeExecutionError(
      'validation',
      'Production structure prediction may only write inside the Task namespace.',
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, { flag: 'wx' });
  return absolute;
}

function inspectArtifact(
  taskDir: string,
  artifact: NonNullable<NodeRunResult['outputs'][number]['artifacts']>[number],
): ContainerArtifactFile {
  const absolute = resolve(taskDir, artifact.relativePath);
  if (!isInside(resolve(taskDir), absolute) || !existsSync(absolute)) {
    throw new NodeExecutionError(
      'validation',
      `Production structure prediction did not write declared artifact "${artifact.relativePath}".`,
    );
  }
  const bytes = readFileSync(absolute);
  if (statSync(absolute).size !== bytes.byteLength) {
    throw new NodeExecutionError(
      'validation',
      `Production structure prediction produced an unstable artifact "${artifact.relativePath}".`,
    );
  }
  return {
    name: artifact.name,
    relativePath: artifact.relativePath,
    mediaType: artifact.mediaType,
    ...(artifact.schema ? { schema: artifact.schema } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

function toContainerMetrics(
  result: NodeRunResult,
): ContainerMetric[] {
  const metrics: ContainerMetric[] = [];
  for (const [metricId, value] of Object.entries(result.metrics ?? {})) {
    const spec = structurePredictionProductionManifest.metrics.find(
      (candidate) => candidate.id === metricId,
    );
    if (!spec) {
      throw new NodeExecutionError(
        'validation',
        `Production structure prediction reported undeclared Metric "${metricId}".`,
      );
    }
    if (typeof value !== spec.valueType) {
      throw new NodeExecutionError(
        'validation',
        `Production structure prediction Metric "${metricId}" must be a ${spec.valueType}.`,
      );
    }
    metrics.push({
      spec,
      value,
      schema: {
        namespace: `sflow.binder.${IDENTITY.manifestId}`,
        name: metricId,
        version: IDENTITY.manifestVersion,
      },
    });
  }
  return metrics;
}

/**
 * Executes the container entrypoint against a Task namespace. Throws a
 * `NodeExecutionError` when the Node package's input or output contract is
 * violated; the scheduler reports that as a failed Job and the Orchestrator
 * persists a diagnosable Task failure.
 */
export async function runProductionStructurePredictionContainer(
  options: ProductionContainerOptions,
): Promise<ContainerTaskResult> {
  const taskDir = resolve(options.taskDir);
  const log = options.log ?? (() => undefined);
  const input = readTaskInput(options.taskInputPath);

  log(
    `structure-prediction-production manifest=${input.manifestId}@${input.manifestVersion}`,
  );
  log(
    `structure-prediction-production run=${input.runId} task=${input.taskId} node=${input.nodeId} attempt=${input.attempt}`,
  );
  log(`structure-prediction-production task-input=${SLURM_TASK_INPUT_FILE}`);

  const context: NodeRunContext = {
    runId: input.runId,
    taskId: input.taskId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    outputDir: taskDir,
    signal: new AbortController().signal,
    log,
    writeFile: (relativePath, contents) => writeTextFile(taskDir, relativePath, contents),
    // Production containers receive only managed Task inputs. This Node has no
    // path-backed parameters, so it must never reach into the Project tree.
    readProjectFile: () => undefined,
  };

  const result = runProductionStructurePrediction(
    input.inputs,
    input.parameters,
    context,
  );

  const outputs: ContainerOutput[] = result.outputs.map((output) => ({
    portId: output.portId,
    ...(output.value !== undefined ? { value: output.value } : {}),
    artifacts: (output.artifacts ?? []).map((artifact) =>
      inspectArtifact(taskDir, artifact),
    ),
  }));
  const metrics = toContainerMetrics(result);

  const resultPath = options.resultPath;
  mkdirSync(dirname(resultPath), { recursive: true });
  const temporary = `${resultPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ outputs, metrics }, null, 2)}\n`);
  renameSync(temporary, resultPath);
  log(`structure-prediction-production wrote ${STRUCTURE_PREDICTION_RESULT_FILE}`);

  return { outputs, metrics };
}
