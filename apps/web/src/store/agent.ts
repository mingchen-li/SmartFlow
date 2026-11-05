import { create } from 'zustand';
import type { AgentPatch } from '@sflow/domain';

export type AgentMode = 'workflow' | 'node';

export interface AgentMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
}

/**
 * Conversation, mode, and patch preview state for the Agent surface. This is
 * presentation state shared by the docked and floating presentations; it is
 * never persisted with the Workflow draft or a Run snapshot.
 */
interface AgentState {
  mode: AgentMode;
  messagesByContext: Record<string, AgentMessage[]>;
  patches: AgentPatch[];
  patchErrors: Record<string, string>;
  proposalError: string | null;
  setMode: (mode: AgentMode) => void;
  recordExchange: (
    contextKey: string,
    userText: string,
    agentText: string,
  ) => void;
  addPatch: (patch: AgentPatch) => void;
  updatePatch: (patch: AgentPatch) => void;
  setPatchError: (patchId: string, message: string) => void;
  setProposalError: (message: string | null) => void;
}

let nextMessageId = 1;

function messageId(): string {
  const id = `agent-message-${nextMessageId}`;
  nextMessageId += 1;
  return id;
}

export const useAgentStore = create<AgentState>((set) => ({
  mode: 'workflow',
  messagesByContext: {},
  patches: [],
  patchErrors: {},
  proposalError: null,

  setMode: (mode) => set({ mode }),

  recordExchange: (contextKey, userText, agentText) =>
    set((state) => ({
      messagesByContext: {
        ...state.messagesByContext,
        [contextKey]: [
          ...(state.messagesByContext[contextKey] ?? []),
          { id: messageId(), role: 'user', text: userText },
          { id: messageId(), role: 'agent', text: agentText },
        ],
      },
    })),

  addPatch: (patch) =>
    set((state) => ({ patches: [...state.patches, patch] })),

  updatePatch: (patch) =>
    set((state) => ({
      patches: state.patches.map((candidate) =>
        candidate.id === patch.id ? patch : candidate,
      ),
    })),

  setPatchError: (patchId, message) =>
    set((state) => ({
      patchErrors: { ...state.patchErrors, [patchId]: message },
    })),

  setProposalError: (proposalError) => set({ proposalError }),
}));
