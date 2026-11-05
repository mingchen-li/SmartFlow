import {
  defaultParameters,
  type CanvasPosition,
  type NodeManifest,
  type WorkflowIR,
  type WorkflowNodeInstance,
} from '@sflow/domain';

/**
 * Pure Node-instance operations shared by Node Library insertion, duplication,
 * and tests. Positions belong to EditorLayout, so the insert helpers accept a
 * position from the caller rather than mutating Workflow IR.
 */

export function nextNodeId(): string {
  return globalThis.crypto.randomUUID();
}

function firstFreeLabel(base: string, labels: readonly string[]): string {
  if (!labels.includes(base)) return base;

  let counter = 2;
  while (labels.includes(`${base} ${counter}`)) {
    counter += 1;
  }
  return `${base} ${counter}`;
}

/** Creates a configured instance from Manifest defaults, never a placeholder. */
export function createNodeInstance(
  manifest: NodeManifest,
  existingNodes: readonly WorkflowNodeInstance[],
): WorkflowNodeInstance {
  const label = firstFreeLabel(
    manifest.name,
    existingNodes.map((node) => node.label),
  );

  return {
    id: nextNodeId(),
    manifestId: manifest.id,
    manifestVersion: manifest.version,
    label,
    parameters: defaultParameters(manifest),
    resources: {},
  };
}

/** Creates a new instance of the same Manifest with a copy of its configuration. */
export function duplicateNodeInstance(
  workflow: Pick<WorkflowIR, 'nodes'>,
  nodeId: string,
): WorkflowNodeInstance | undefined {
  const source = workflow.nodes.find((node) => node.id === nodeId);
  if (!source) return undefined;

  const label = firstFreeLabel(
    `${source.label} copy`,
    workflow.nodes.map((node) => node.label),
  );

  return {
    id: nextNodeId(),
    manifestId: source.manifestId,
    manifestVersion: source.manifestVersion,
    label,
    parameters: structuredClone(source.parameters),
    resources: structuredClone(source.resources),
  };
}

/** Cascading placement for new Nodes; layout state, never Workflow IR. */
export function defaultNodePosition(index: number): CanvasPosition {
  const columns = 4;
  return {
    x: 80 + (index % columns) * 230,
    y: 80 + Math.floor(index / columns) * 150,
  };
}

export const DUPLICATE_OFFSET = 34;
