import type {
  FileReference,
  NodeManifest,
  WorkflowDraft,
  WorkflowIR,
} from '@sflow/domain';
import { AgentSurface } from './AgentSurface';

export interface AgentPanelProps {
  width: number;
  onCollapse: () => void;
  draftId: string;
  manifests: readonly NodeManifest[];
  fileReferences: readonly FileReference[];
  saveNow: () => Promise<WorkflowDraft | null>;
  onWorkflowApplied: (workflow: WorkflowIR, revision: number) => void;
  onNotify: (message: string) => void;
}

/** Docked Agent presentation used outside app-level maximize. */
export function AgentPanel({
  width,
  onCollapse,
  ...surfaceProps
}: AgentPanelProps) {
  return (
    <aside
      className="panel agent-panel"
      style={{ width }}
      aria-label="Agent"
      data-testid="agent-panel"
    >
      <header className="panel-header">
        <span>Agent</span>
        <span className="panel-header-actions">
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Collapse agent panel"
            onClick={onCollapse}
          >
            ›
          </button>
        </span>
      </header>

      <AgentSurface {...surfaceProps} />
    </aside>
  );
}
