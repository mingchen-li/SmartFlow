import type { NodeManifest } from './workflow';
import type { NodeFailureKind, SchemaRef } from './execution';

/**
 * A Node implementation may throw this error to declare how its failure should
 * be classified. The Compute Executor persists the classification so the
 * Orchestrator can apply the Manifest RetryPolicy: `transient`, `timeout`, and
 * `exit-code` may be retried; `parameter` and `validation` never are.
 */
export class NodeExecutionError extends Error {
  readonly failureKind: NodeFailureKind;

  constructor(failureKind: NodeFailureKind, message: string) {
    super(message);
    this.name = 'NodeExecutionError';
    this.failureKind = failureKind;
  }
}

/**
 * Node execution contract shared by built-in Node packages and the local
 * Compute Executor (ticket #7).
 *
 * `run(input, params, context)` is deterministic for a given parameter set and
 * seed. It may read path-backed Project files through the context, writes only
 * inside its Task namespace, and declares the files it produced so the
 * Orchestrator can record immutable Artifacts.
 */

export interface NodeOutputArtifact {
  /** Name recorded with the Artifact. */
  name: string;
  /** File path relative to the Task namespace. */
  relativePath: string;
  mediaType: string;
  schema?: SchemaRef;
}

export interface NodeRunOutput {
  portId: string;
  /** Inline value handed to downstream Tasks through the data edge. */
  value?: unknown;
  artifacts?: NodeOutputArtifact[];
}

export type NodeMetricValue = number | string | boolean;

export interface NodeRunResult {
  outputs: NodeRunOutput[];
  /** Values keyed by the Manifest's declared Metric id. */
  metrics?: Record<string, NodeMetricValue>;
}

export interface NodeRunContext {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  /** Absolute Task namespace directory. */
  outputDir: string;
  signal: AbortSignal;
  log(line: string): void;
  /**
   * Writes a file once inside the Task namespace and returns its absolute
   * path. Overwriting an existing output fails: Task outputs are immutable.
   */
  writeFile(relativePath: string, contents: string | Uint8Array): string;
  /**
   * Reads a path-backed Project file. Returns undefined when the path is
   * outside the Project, missing, or unreadable.
   */
  readProjectFile(projectRelativePath: string): string | undefined;
}

export interface NodeImplementation {
  manifest: NodeManifest;
  run(
    input: Record<string, unknown>,
    params: Record<string, unknown>,
    context: NodeRunContext,
  ): NodeRunResult | Promise<NodeRunResult>;
}

export interface NodeRegistry {
  get(manifestId: string, manifestVersion: string): NodeImplementation | undefined;
  list(): readonly NodeImplementation[];
}
