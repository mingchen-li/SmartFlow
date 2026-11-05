import { z } from 'zod';
import {
  FileReferenceParameterValueSchema,
  NodeEnvironmentSchema,
  NodeResourcesSchema,
  RetryPolicySchema,
  WorkflowIRSchema,
  defaultParameters,
  findManifest,
  type NodeManifest,
  type WorkflowIR,
} from './workflow';

/**
 * Run contracts (ticket #6). A Run carries an immutable snapshot of the exact
 * execution contract used at start time. Snapshot objects are strict: layout,
 * panel geometry, selection, maximize mode, Agent presentation, and Node
 * Library state are not part of a Run.
 */

export const RUN_SNAPSHOT_VERSION = 1;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * A path-backed File Reference used by a Node parameter at Run start. It keeps
 * the path selected by the user and deliberately carries no content digest
 * (ADR-0004, ADR-0008).
 */
export const RunFileReferenceSchema = z.strictObject({
  parameterId: z.string().min(1),
  fileReferenceId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type RunFileReference = z.infer<typeof RunFileReferenceSchema>;

/**
 * Resolved per-Node execution contract: parameter defaults merged with the
 * instance configuration, plus the Manifest resources, environment, and retry
 * policy that the Run must keep using even if the Manifest changes later.
 */
export const RunNodeSnapshotSchema = z.strictObject({
  nodeId: z.string().min(1),
  label: z.string().min(1),
  manifestId: z.string().min(1),
  manifestVersion: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  resources: NodeResourcesSchema,
  environment: NodeEnvironmentSchema,
  retry: RetryPolicySchema,
  fileReferences: z.array(RunFileReferenceSchema),
});
export type RunNodeSnapshot = z.infer<typeof RunNodeSnapshotSchema>;

export const RunSnapshotSchema = z.strictObject({
  version: z.number().int().positive(),
  workflow: WorkflowIRSchema,
  nodes: z.array(RunNodeSnapshotSchema),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const RunSchema = z.strictObject({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  status: RunStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  snapshot: RunSnapshotSchema,
});
export type Run = z.infer<typeof RunSchema>;

export const CreateRunRequestSchema = z.strictObject({});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const CreateRunResponseSchema = z.strictObject({ run: RunSchema });
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const RunListResponseSchema = z.strictObject({ runs: z.array(RunSchema) });
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const RunParamsSchema = z.object({
  id: z.string().min(1).max(200),
});
export type RunParams = z.infer<typeof RunParamsSchema>;

function fileReferencesUsedBy(
  manifest: NodeManifest,
  parameters: Record<string, unknown>,
): RunFileReference[] {
  const references: RunFileReference[] = [];
  for (const spec of manifest.parameters) {
    if (spec.type !== 'file-reference') continue;
    const parsed = FileReferenceParameterValueSchema.safeParse(parameters[spec.id]);
    if (!parsed.success) continue;
    references.push({
      parameterId: spec.id,
      fileReferenceId: parsed.data.fileReferenceId,
      path: parsed.data.path,
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
    });
  }
  return references;
}

/**
 * Builds the immutable Run snapshot from a validated Workflow draft. The input
 * is re-parsed with the strict Workflow IR schema, so layout-shaped fields
 * cannot enter the snapshot. Every nested value is cloned: later edits to the
 * draft or to installed Manifests cannot mutate a captured Run.
 */
export function createRunSnapshot(
  workflow: WorkflowIR | unknown,
  manifests: readonly NodeManifest[],
): RunSnapshot {
  const ir = WorkflowIRSchema.parse(workflow);

  const nodes = ir.nodes.map((node): RunNodeSnapshot => {
    const manifest = findManifest(manifests, node.manifestId, node.manifestVersion);
    if (!manifest) {
      throw new Error(
        `Cannot capture a Run snapshot: Manifest "${node.manifestId}@${node.manifestVersion}" is not installed.`,
      );
    }

    const parameters = {
      ...defaultParameters(manifest),
      ...structuredClone(node.parameters),
    };

    return {
      nodeId: node.id,
      label: node.label,
      manifestId: node.manifestId,
      manifestVersion: node.manifestVersion,
      parameters,
      resources: {
        ...structuredClone(manifest.resources),
        ...structuredClone(node.resources),
      },
      environment: structuredClone(manifest.environment),
      retry: structuredClone(manifest.retry),
      fileReferences: fileReferencesUsedBy(manifest, parameters),
    };
  });

  return {
    version: RUN_SNAPSHOT_VERSION,
    workflow: structuredClone(ir),
    nodes,
  };
}
