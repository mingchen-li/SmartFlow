import { create } from 'zustand';

export const EXPLORER_MIN_WIDTH = 200;
export const EXPLORER_MAX_WIDTH = 420;
export const AGENT_MIN_WIDTH = 240;
export const AGENT_MAX_WIDTH = 480;

interface LayoutState {
  explorerWidth: number;
  agentWidth: number;
  explorerCollapsed: boolean;
  agentCollapsed: boolean;
  setExplorerWidth: (width: number) => void;
  setAgentWidth: (width: number) => void;
  resizeExplorerBy: (delta: number) => void;
  resizeAgentBy: (delta: number) => void;
  setExplorerCollapsed: (collapsed: boolean) => void;
  setAgentCollapsed: (collapsed: boolean) => void;
  toggleExplorer: () => void;
  toggleAgent: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * In-memory workspace layout. Panel geometry is UI state and deliberately not
 * persisted with the Workflow draft or Run snapshots.
 */
export const useLayoutStore = create<LayoutState>((set) => ({
  explorerWidth: 260,
  agentWidth: 300,
  explorerCollapsed: false,
  agentCollapsed: false,
  setExplorerWidth: (width) =>
    set({ explorerWidth: clamp(width, EXPLORER_MIN_WIDTH, EXPLORER_MAX_WIDTH) }),
  setAgentWidth: (width) =>
    set({ agentWidth: clamp(width, AGENT_MIN_WIDTH, AGENT_MAX_WIDTH) }),
  resizeExplorerBy: (delta) =>
    set((state) => ({
      explorerWidth: clamp(state.explorerWidth + delta, EXPLORER_MIN_WIDTH, EXPLORER_MAX_WIDTH),
    })),
  resizeAgentBy: (delta) =>
    set((state) => ({
      agentWidth: clamp(state.agentWidth + delta, AGENT_MIN_WIDTH, AGENT_MAX_WIDTH),
    })),
  setExplorerCollapsed: (collapsed) => set({ explorerCollapsed: collapsed }),
  setAgentCollapsed: (collapsed) => set({ agentCollapsed: collapsed }),
  toggleExplorer: () => set((state) => ({ explorerCollapsed: !state.explorerCollapsed })),
  toggleAgent: () => set((state) => ({ agentCollapsed: !state.agentCollapsed })),
}));
