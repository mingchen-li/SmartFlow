import { create } from 'zustand';

export const EXPLORER_MIN_WIDTH = 200;
export const EXPLORER_MAX_WIDTH = 420;
export const AGENT_MIN_WIDTH = 240;
export const AGENT_MAX_WIDTH = 480;

export const AGENT_FLOAT_BALL_SIZE = 58;
export const AGENT_FLOAT_MIN_WIDTH = 280;
export const AGENT_FLOAT_MAX_WIDTH = 520;
export const AGENT_FLOAT_MIN_HEIGHT = 340;

export interface FloatingPoint {
  x: number;
  y: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

interface LayoutState {
  explorerWidth: number;
  agentWidth: number;
  explorerCollapsed: boolean;
  agentCollapsed: boolean;
  /** Floating Agent presentation, used only in app-level maximize. */
  agentFloatOpen: boolean;
  agentBallPosition: FloatingPoint | null;
  agentPanelPosition: FloatingPoint | null;
  agentPanelSize: FloatingSize;
  setExplorerWidth: (width: number) => void;
  setAgentWidth: (width: number) => void;
  resizeExplorerBy: (delta: number) => void;
  resizeAgentBy: (delta: number) => void;
  setExplorerCollapsed: (collapsed: boolean) => void;
  setAgentCollapsed: (collapsed: boolean) => void;
  toggleExplorer: () => void;
  toggleAgent: () => void;
  setAgentFloatOpen: (open: boolean) => void;
  setAgentBallPosition: (position: FloatingPoint) => void;
  setAgentPanelPosition: (position: FloatingPoint) => void;
  setAgentPanelSize: (size: FloatingSize) => void;
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
  agentFloatOpen: false,
  agentBallPosition: null,
  agentPanelPosition: null,
  agentPanelSize: { width: 360, height: 480 },
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
  setAgentFloatOpen: (agentFloatOpen) => set({ agentFloatOpen }),
  setAgentBallPosition: (agentBallPosition) => set({ agentBallPosition }),
  setAgentPanelPosition: (agentPanelPosition) => set({ agentPanelPosition }),
  setAgentPanelSize: (agentPanelSize) => set({ agentPanelSize }),
}));
