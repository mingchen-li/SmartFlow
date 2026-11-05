import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { NodeManifest, NodePort, WorkflowNodeInstance } from '@sflow/domain';

export interface SFlowNodeData extends Record<string, unknown> {
  instance: WorkflowNodeInstance;
  manifest: NodeManifest;
  selected: boolean;
  flowPosition: { x: number; y: number };
}

export type SFlowCanvasNode = Node<SFlowNodeData, 'sflow'>;

const CATEGORY_ACCENTS: Record<string, string> = {
  Inputs: 'accent-input',
  'Protein design': 'accent-design',
  'Structure prediction': 'accent-prediction',
  Analysis: 'accent-analysis',
};

function categoryAccent(category: string): string {
  return CATEGORY_ACCENTS[category] ?? 'accent-neutral';
}

function handleTop(index: number): number {
  return 36 + index * 18;
}

function portKindLabel(port: NodePort): string {
  return port.kind === 'control' ? 'control' : (port.dataType ?? 'data');
}

/**
 * A Workflow Node rendered on the canvas. Ports come from the Node Manifest;
 * display-only position and selection are supplied by EditorLayout state.
 */
export function WorkflowNodeCard({ data }: NodeProps<SFlowCanvasNode>) {
  const { instance, manifest, selected, flowPosition } = data;

  return (
    <div
      className={`sflow-node ${categoryAccent(manifest.category)}`}
      data-testid="canvas-node"
      data-node-id={instance.id}
      data-manifest-id={manifest.id}
      data-selected={selected ? 'true' : 'false'}
      data-flow-x={Math.round(flowPosition.x)}
      data-flow-y={Math.round(flowPosition.y)}
      aria-label={`${instance.label} Node`}
    >
      <div className="sflow-node-accent" aria-hidden="true" />

      <div className="sflow-node-heading">
        <span className="sflow-node-name">{instance.label}</span>
        <span className="sflow-node-type">{manifest.type}</span>
      </div>
      <span className="sflow-node-category">{manifest.category}</span>
      <span className="sflow-node-ports">
        {manifest.inputs.length} in · {manifest.outputs.length} out
      </span>

      {manifest.inputs.map((port, index) => (
        <Handle
          key={`in-${port.id}`}
          id={port.id}
          type="target"
          position={Position.Left}
          className={`sflow-handle sflow-handle-${port.kind}`}
          style={{ top: handleTop(index) }}
          data-testid={`port-${port.id}-input`}
          data-port-kind={port.kind}
          data-port-type={portKindLabel(port)}
          title={`${port.name} (${portKindLabel(port)})`}
          isConnectable
        />
      ))}

      {manifest.outputs.map((port, index) => (
        <Handle
          key={`out-${port.id}`}
          id={port.id}
          type="source"
          position={Position.Right}
          className={`sflow-handle sflow-handle-${port.kind}`}
          style={{ top: handleTop(index) }}
          data-testid={`port-${port.id}-output`}
          data-port-kind={port.kind}
          data-port-type={portKindLabel(port)}
          title={`${port.name} (${portKindLabel(port)})`}
          isConnectable
        />
      ))}
    </div>
  );
}
