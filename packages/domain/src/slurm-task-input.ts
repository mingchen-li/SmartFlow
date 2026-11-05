import { z } from 'zod';
import { RunFileReferenceSchema, type RunFileReference } from './run';
import { NodeResourcesSchema, type NodeResources } from './workflow';

/**
 * Slurm Task input contract (tickets #10, #12).
 *
 * The Server writes one `task-input.json` per Task attempt for the container
 * that runs inside a Slurm Job. The file name, version, and strict schema are
 * shared by the Orchestrator that writes the file and the production Node
 * container that reads it, so both sides validate the same contract.
 */

export const SLURM_TASK_INPUT_FILE = 'task-input.json';
export const SLURM_TASK_INPUT_VERSION = 1;

export const SlurmTaskInputSchema = z.strictObject({
  version: z.literal(SLURM_TASK_INPUT_VERSION),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  attempt: z.number().int().min(1),
  manifestId: z.string().min(1),
  manifestVersion: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  fileReferences: z.array(RunFileReferenceSchema),
  inputs: z.record(z.string(), z.unknown()),
  resources: NodeResourcesSchema,
});
export type SlurmTaskInput = z.infer<typeof SlurmTaskInputSchema>;

/**
 * The fields the Orchestrator resolves for a Task attempt. It is structurally
 * satisfied by `TaskSpec` without making this package depend on the
 * Orchestrator.
 */
export interface SlurmTaskInputSource {
  runId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  manifestId: string;
  manifestVersion: string;
  parameters: Record<string, unknown>;
  fileReferences: readonly RunFileReference[];
  inputs: Record<string, unknown>;
  resources: NodeResources;
}

/** Builds the exact Task input record written into the Task namespace. */
export function createSlurmTaskInput(spec: SlurmTaskInputSource): SlurmTaskInput {
  return SlurmTaskInputSchema.parse({
    version: SLURM_TASK_INPUT_VERSION,
    runId: spec.runId,
    taskId: spec.taskId,
    nodeId: spec.nodeId,
    attempt: spec.attempt,
    manifestId: spec.manifestId,
    manifestVersion: spec.manifestVersion,
    parameters: spec.parameters,
    fileReferences: spec.fileReferences,
    inputs: spec.inputs,
    resources: spec.resources,
  });
}
