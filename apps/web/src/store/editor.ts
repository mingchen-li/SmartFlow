import { create } from 'zustand';
import {
  createEmptyEditorLayout,
  createEmptyWorkflow,
  type CanvasPosition,
  type CanvasViewport,
  type EditorLayout,
  type NodeManifest,
  type NodeResources,
  type WorkflowEdge,
  type WorkflowIR,
  type WorkflowNodeInstance,
} from '@sflow/domain';
import {
  createNodeInstance,
  defaultNodePosition,
  duplicateNodeInstance,
  DUPLICATE_OFFSET,
} from '../editor/model';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface HydrateEditorInput {
  name: string;
  workflow: WorkflowIR;
  layout: EditorLayout;
}

export interface EditorState {
  draftName: string;
  workflow: WorkflowIR;
  layout: EditorLayout;
  hydrated: boolean;
  /** Document revision; every persistence-worthy mutation increments it. */
  revision: number;
  /** Last revision confirmed by the Server; drives debounced autosave. */
  savedRevision: number;
  saveState: SaveState;
  /** Runtime UI state, deliberately not part of the draft. */
  libraryOpen: boolean;
  maximize: boolean;
  hydrate: (input: HydrateEditorInput) => void;
  markSaved: (revision: number) => void;
  setSaveState: (state: SaveState) => void;
  setLibraryOpen: (open: boolean) => void;
  setMaximize: (maximize: boolean) => void;
  insertManifest: (manifest: NodeManifest) => WorkflowNodeInstance;
  duplicateSelectedNode: () => WorkflowNodeInstance | undefined;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  addEdge: (edge: WorkflowEdge) => void;
  updateNodePosition: (nodeId: string, position: CanvasPosition) => void;
  updateViewport: (viewport: CanvasViewport) => void;
  selectNode: (nodeId: string | null) => void;
  selectEdge: (edgeId: string | null) => void;
  clearSelection: () => void;
  updateNodeParameters: (nodeId: string, parameters: Record<string, unknown>) => void;
  updateNodeResources: (nodeId: string, resources: NodeResources) => void;
}

function scenePosition(state: Pick<EditorState, 'workflow' | 'layout'>): CanvasPosition {
  const used = new Set(
    Object.values(state.layout.positions).map((position) => `${position.x}:${position.y}`),
  );
  let index = state.workflow.nodes.length;
  let position = defaultNodePosition(index);
  while (used.has(`${position.x}:${position.y}`)) {
    index += 1;
    position = defaultNodePosition(index);
  }
  return position;
}

function nodeExists(state: Pick<EditorState, 'workflow'>, nodeId: string): boolean {
  return state.workflow.nodes.some((node) => node.id === nodeId);
}

/**
 * In-memory Workflow editor document. Workflow IR and EditorLayout are kept
 * separate; runtime UI state (Node Library, maximize) is never written to
 * either persisted object.
 */
export const useEditorStore = create<EditorState>((set, get) => ({
  draftName: 'Binder design',
  workflow: createEmptyWorkflow(),
  layout: createEmptyEditorLayout(),
  hydrated: false,
  revision: 0,
  savedRevision: 0,
  saveState: 'idle',
  libraryOpen: false,
  maximize: false,

  hydrate: ({ name, workflow, layout }) =>
    set({
      draftName: name,
      workflow,
      layout,
      hydrated: true,
      revision: 0,
      savedRevision: 0,
      saveState: 'idle',
      libraryOpen: false,
      maximize: false,
    }),

  markSaved: (revision) =>
    set((state) => ({
      savedRevision: revision,
      saveState: 'saved',
    })),

  setSaveState: (saveState) => set({ saveState }),
  setLibraryOpen: (libraryOpen) => set({ libraryOpen }),
  setMaximize: (maximize) => set({ maximize }),

  insertManifest: (manifest) => {
    const state = get();
    const node = createNodeInstance(manifest, state.workflow.nodes);
    const position = scenePosition(state);

    set({
      workflow: { ...state.workflow, nodes: [...state.workflow.nodes, node] },
      layout: {
        ...state.layout,
        positions: { ...state.layout.positions, [node.id]: position },
        selection: { nodeId: node.id, edgeId: null },
      },
      revision: state.revision + 1,
    });

    return node;
  },

  duplicateSelectedNode: () => {
    const state = get();
    const selectedId = state.layout.selection.nodeId;
    if (!selectedId) return undefined;

    const duplicate = duplicateNodeInstance(state.workflow, selectedId);
    if (!duplicate) return undefined;

    const sourcePosition =
      state.layout.positions[selectedId] ?? scenePosition(state);
    const position = {
      x: sourcePosition.x + DUPLICATE_OFFSET,
      y: sourcePosition.y + DUPLICATE_OFFSET,
    };

    set({
      workflow: { ...state.workflow, nodes: [...state.workflow.nodes, duplicate] },
      layout: {
        ...state.layout,
        positions: { ...state.layout.positions, [duplicate.id]: position },
        selection: { nodeId: duplicate.id, edgeId: null },
      },
      revision: state.revision + 1,
    });

    return duplicate;
  },

  removeNode: (nodeId) => {
    const state = get();
    if (!nodeExists(state, nodeId)) return;

    const { [nodeId]: _removed, ...positions } = state.layout.positions;
    set({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.filter((node) => node.id !== nodeId),
        edges: state.workflow.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
      },
      layout: {
        ...state.layout,
        positions,
        selection:
          state.layout.selection.nodeId === nodeId
            ? { ...state.layout.selection, nodeId: null }
            : state.layout.selection,
      },
      revision: state.revision + 1,
    });
  },

  removeEdge: (edgeId) => {
    const state = get();
    if (!state.workflow.edges.some((edge) => edge.id === edgeId)) return;

    set({
      workflow: {
        ...state.workflow,
        edges: state.workflow.edges.filter((edge) => edge.id !== edgeId),
      },
      layout: {
        ...state.layout,
        selection:
          state.layout.selection.edgeId === edgeId
            ? { ...state.layout.selection, edgeId: null }
            : state.layout.selection,
      },
      revision: state.revision + 1,
    });
  },

  addEdge: (edge) => {
    const state = get();
    if (state.workflow.edges.some((candidate) => candidate.id === edge.id)) return;
    set({
      workflow: { ...state.workflow, edges: [...state.workflow.edges, edge] },
      layout: { ...state.layout, selection: { nodeId: null, edgeId: edge.id } },
      revision: state.revision + 1,
    });
  },

  updateNodePosition: (nodeId, position) => {
    const state = get();
    const current = state.layout.positions[nodeId];
    if (current && current.x === position.x && current.y === position.y) return;

    set({
      layout: {
        ...state.layout,
        positions: { ...state.layout.positions, [nodeId]: position },
      },
      revision: state.revision + 1,
    });
  },

  updateViewport: (viewport) => {
    const state = get();
    const current = state.layout.viewport;
    if (
      current.x === viewport.x &&
      current.y === viewport.y &&
      current.zoom === viewport.zoom
    ) {
      return;
    }

    set({
      layout: { ...state.layout, viewport },
      revision: state.revision + 1,
    });
  },

  selectNode: (nodeId) => {
    const state = get();
    if (state.layout.selection.nodeId === nodeId && state.layout.selection.edgeId === null) {
      return;
    }
    set({
      layout: {
        ...state.layout,
        selection: { nodeId, edgeId: null },
      },
      revision: state.revision + 1,
    });
  },

  selectEdge: (edgeId) => {
    const state = get();
    if (state.layout.selection.edgeId === edgeId && state.layout.selection.nodeId === null) {
      return;
    }
    set({
      layout: {
        ...state.layout,
        selection: { nodeId: null, edgeId },
      },
      revision: state.revision + 1,
    });
  },

  clearSelection: () => {
    const state = get();
    if (!state.layout.selection.nodeId && !state.layout.selection.edgeId) return;
    set({
      layout: {
        ...state.layout,
        selection: { nodeId: null, edgeId: null },
      },
      revision: state.revision + 1,
    });
  },

  updateNodeParameters: (nodeId, parameters) => {
    const state = get();
    if (!nodeExists(state, nodeId)) return;
    set({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((node) =>
          node.id === nodeId ? { ...node, parameters } : node,
        ),
      },
      revision: state.revision + 1,
    });
  },

  updateNodeResources: (nodeId, resources) => {
    const state = get();
    if (!nodeExists(state, nodeId)) return;
    set({
      workflow: {
        ...state.workflow,
        nodes: state.workflow.nodes.map((node) =>
          node.id === nodeId ? { ...node, resources } : node,
        ),
      },
      revision: state.revision + 1,
    });
  },
}));
