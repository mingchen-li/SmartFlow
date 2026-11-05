import type { Project } from '@sflow/domain';
import type { SaveState } from './Workspace';

export interface GlobalToolbarProps {
  project: Project;
  draftName: string;
  saveState: SaveState;
  onSave: () => void;
  onRun: () => void;
}

/** The persistent Project-level toolbar: identity, state, save, and Run. */
export function GlobalToolbar({
  project,
  draftName,
  saveState,
  onSave,
  onRun,
}: GlobalToolbarProps) {
  const projectState = project.state === 'running' ? 'Running' : 'Idle';

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved'
        : saveState === 'error'
          ? 'Save failed'
          : '';

  return (
    <header className="global-toolbar" data-testid="global-toolbar">
      <span className="brand" data-testid="brand">
        SFlow
      </span>
      <span className="toolbar-divider" aria-hidden="true" />
      <div className="project-identity">
        <span className="project-name" data-testid="project-name">
          {project.name}
        </span>
        <span className="badge badge-neutral" data-testid="project-state">
          {projectState}
        </span>
      </div>

      <div className="toolbar-spacer" />

      <span className="muted" role="status" aria-live="polite">
        {saveLabel}
      </span>

      <div className="toolbar-actions">
        <button
          type="button"
          className="button button-outline"
          onClick={onSave}
          disabled={saveState === 'saving'}
          aria-label={`Save ${draftName}`}
        >
          Save
        </button>
        <button type="button" className="button button-primary" onClick={onRun}>
          Run
        </button>
      </div>
    </header>
  );
}
