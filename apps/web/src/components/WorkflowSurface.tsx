import type { WorkspaceSection } from './PrimaryNav';

export interface WorkflowSurfaceProps {
  draftName: string;
  onNavigate: (section: WorkspaceSection) => void;
  onValidate: () => void;
}

/**
 * Workflow tab strip, Workflow toolbar, and canvas seam. The Workflow IR
 * editor lands in a later ticket; this surface keeps the shell contract.
 */
export function WorkflowSurface({ draftName, onNavigate, onValidate }: WorkflowSurfaceProps) {
  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label="Open Workflow files"
        data-testid="workflow-tabs"
      >
        <button type="button" className="tab" role="tab" aria-selected="true">
          {draftName}
        </button>
      </div>

      <div className="workflow-toolbar" data-testid="workflow-toolbar">
        <span className="badge badge-info">Draft</span>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className="button button-sm button-outline"
          onClick={() => onNavigate('node-library')}
        >
          Add node
        </button>
        <button type="button" className="button button-sm button-outline" onClick={onValidate}>
          Validate
        </button>
      </div>

      <div className="editor-surface" data-testid="workflow-canvas">
        <div className="editor-placeholder">
          <h2>Binder design Workflow</h2>
          <p>
            This Workflow is empty. Add Nodes from the Node Library to build the target input,
            candidate generation, sequence design, structure scoring, and candidate comparison path.
          </p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => onNavigate('node-library')}
          >
            Open Node Library
          </button>
        </div>
      </div>
    </>
  );
}
