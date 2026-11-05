import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import {
  findManifest,
  validateConnection,
  type NodeManifest,
  type WorkflowEdge,
} from '@sflow/domain';
import { nextNodeId } from '../editor/model';
import { useEditorStore } from '../store/editor';
import { WorkflowNodeCard, type SFlowCanvasNode } from './WorkflowNodeCard';

const NODE_TYPES = { sflow: WorkflowNodeCard };

const UNKNOWN_MANIFEST: NodeManifest = {
  id: 'unknown',
  version: 'unknown',
  name: 'Unknown Node',
  description: 'The Node Manifest version is not installed in this Project.',
  category: 'Unknown',
  type: 'unknown',
  inputs: [],
  outputs: [],
  parameters: [],
  metrics: [],
  resources: {},
  environment: { kind: 'container', image: 'unknown' },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
};

function fallbackManifest(manifestId: string, version: string): NodeManifest {
  return { ...UNKNOWN_MANIFEST, id: manifestId, version };
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function candidateFor(
  connection: Connection | Edge,
): WorkflowEdge | undefined {
  if (
    !connection.source ||
    !connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  ) {
    return undefined;
  }

  return {
    id: `edge-${nextNodeId()}`,
    source: connection.source,
    sourcePort: connection.sourceHandle,
    target: connection.target,
    targetPort: connection.targetHandle,
  };
}

export interface WorkflowCanvasProps {
  manifests: readonly NodeManifest[];
  onNotify: (message: string) => void;
}

function WorkflowCanvasViewport({ manifests, onNotify }: WorkflowCanvasProps) {
  const hydrated = useEditorStore((state) => state.hydrated);
  const workflow = useEditorStore((state) => state.workflow);
  const layout = useEditorStore((state) => state.layout);
  const updateViewport = useEditorStore((state) => state.updateViewport);
  const selectNode = useEditorStore((state) => state.selectNode);
  const selectEdge = useEditorStore((state) => state.selectEdge);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const addEdge = useEditorStore((state) => state.addEdge);

  const { zoomIn, zoomOut, fitView, getViewport } = useReactFlow();

  // React Flow measures Nodes with a ResizeObserver and reports the result as
  // a `dimensions` change. Keep those measurements on the controlled Node
  // objects: otherwise recreating a Node (selection, manifest load) discards
  // its dimensions, and re-observing an unchanged element never reports again,
  // leaving the Node hidden and its handles unmeasured. Measurements are
  // runtime canvas geometry, so they stay out of Workflow IR and EditorLayout.
  const [measured, setMeasured] = useState<
    Record<string, { width: number; height: number }>
  >({});

  const nodes = useMemo<SFlowCanvasNode[]>(
    () =>
      workflow.nodes.map((instance) => {
        const manifest =
          findManifest(manifests, instance.manifestId, instance.manifestVersion) ??
          fallbackManifest(instance.manifestId, instance.manifestVersion);
        const position = layout.positions[instance.id] ?? { x: 0, y: 0 };
        const selected = layout.selection.nodeId === instance.id;
        const dimensions = measured[instance.id];

        return {
          id: instance.id,
          type: 'sflow',
          position,
          selected,
          ...(dimensions ? { measured: dimensions } : {}),
          data: { instance, manifest, selected, flowPosition: position },
        };
      }),
    [layout.positions, layout.selection.nodeId, manifests, measured, workflow.nodes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        className: 'sflow-edge',
        selected: layout.selection.edgeId === edge.id,
      })),
    [layout.selection.edgeId, workflow.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<SFlowCanvasNode>[]) => {
      const store = useEditorStore.getState();
      const dimensions = new Map<string, { width: number; height: number }>();
      const removed = new Set<string>();

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          store.updateNodePosition(change.id, change.position);
        } else if (change.type === 'select') {
          if (change.selected) {
            store.selectNode(change.id);
          } else if (store.layout.selection.nodeId === change.id) {
            store.selectNode(null);
          }
        } else if (change.type === 'dimensions' && change.dimensions) {
          dimensions.set(change.id, {
            width: change.dimensions.width,
            height: change.dimensions.height,
          });
        } else if (change.type === 'remove') {
          removed.add(change.id);
          store.removeNode(change.id);
        }
      }

      if (dimensions.size > 0 || removed.size > 0) {
        setMeasured((current) => {
          let changed = false;
          const next = { ...current };
          for (const [id, size] of dimensions) {
            if (
              current[id]?.width !== size.width ||
              current[id]?.height !== size.height
            ) {
              next[id] = size;
              changed = true;
            }
          }
          for (const id of removed) {
            if (id in next) {
              delete next[id];
              changed = true;
            }
          }
          return changed ? next : current;
        });
      }
    },
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const store = useEditorStore.getState();
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) {
            store.selectEdge(change.id);
          } else if (store.layout.selection.edgeId === change.id) {
            store.selectEdge(null);
          }
        } else if (change.type === 'remove') {
          store.removeEdge(change.id);
        }
      }
    },
    [],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      const candidate = candidateFor(connection);
      if (!candidate) return false;
      return validateConnection(workflow, manifests, candidate).valid;
    },
    [manifests, workflow],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const candidate = candidateFor(connection);
      if (!candidate) return;

      const result = validateConnection(workflow, manifests, candidate);
      if (!result.valid) {
        onNotify(result.reason ?? 'That connection is not valid.');
        return;
      }
      addEdge(candidate);
    },
    [addEdge, manifests, onNotify, workflow],
  );

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      updateViewport(viewport);
    },
    [updateViewport],
  );

  async function applyZoom(command: 'in' | 'out' | 'fit'): Promise<void> {
    if (command === 'in') await zoomIn({ duration: 0 });
    else if (command === 'out') await zoomOut({ duration: 0 });
    else await fitView({ duration: 0, padding: 0.2 });
    updateViewport(getViewport());
  }

  const selectedNode = workflow.nodes.find(
    (node) => node.id === layout.selection.nodeId,
  );
  const selectionLabel = selectedNode
    ? `Selected: ${selectedNode.label}`
    : layout.selection.edgeId
      ? 'Selected: connection'
      : 'No selection';

  return (
    <div
      className="workflow-canvas-wrap"
      data-testid="workflow-canvas"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-viewport-x={layout.viewport.x}
      data-viewport-y={layout.viewport.y}
      data-zoom={layout.viewport.zoom}
    >
      <div className="canvas-head">
        <span className="canvas-stat" data-testid="canvas-node-count">
          {plural(workflow.nodes.length, 'Node')}
        </span>
        <span className="canvas-stat" data-testid="canvas-edge-count">
          {plural(workflow.edges.length, 'Edge')}
        </span>
        <span className="canvas-selection" data-testid="canvas-selection">
          {selectionLabel}
        </span>

        <span className="toolbar-spacer" />

        <button
          type="button"
          className="button button-ghost button-icon"
          aria-label="Zoom out"
          data-testid="canvas-zoom-out"
          onClick={() => void applyZoom('out')}
        >
          −
        </button>
        <span className="canvas-zoom" data-testid="canvas-zoom-level">
          {Math.round(layout.viewport.zoom * 100)}%
        </span>
        <button
          type="button"
          className="button button-ghost button-icon"
          aria-label="Zoom in"
          data-testid="canvas-zoom-in"
          onClick={() => void applyZoom('in')}
        >
          +
        </button>
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="canvas-fit-view"
          onClick={() => void applyZoom('fit')}
        >
          Fit
        </button>
      </div>

      <div className="canvas-surface">
        {hydrated ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            defaultViewport={layout.viewport}
            minZoom={0.5}
            maxZoom={1.3}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_event, node) => selectNode(node.id)}
            onEdgeClick={(_event, edge) => selectEdge(edge.id)}
            onPaneClick={clearSelection}
            onMoveEnd={onMoveEnd}
            nodesConnectable
            elementsSelectable
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="var(--color-canvas-dot)"
            />
          </ReactFlow>
        ) : (
          <p className="canvas-loading">Loading Workflow draft…</p>
        )}
      </div>
    </div>
  );
}

/** Canvas seam: React Flow supplies zoom/pan/viewport; the store owns state. */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasViewport {...props} />
    </ReactFlowProvider>
  );
}
