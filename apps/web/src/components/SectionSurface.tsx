import type { WorkspaceSection } from './PrimaryNav';

export interface SectionSurfaceProps {
  section: Exclude<WorkspaceSection, 'workflows' | 'terminal'>;
  selectedFilePath: string | null;
  onNavigate: (section: WorkspaceSection) => void;
}

/**
 * Non-canvas workspace sections. Later tickets replace these placeholders with
 * the file-backed Workflow browser, Node Library, and Run history.
 */
export function SectionSurface({ section, selectedFilePath, onNavigate }: SectionSurfaceProps) {
  return (
    <div className="editor-surface" data-testid={`section-${section}`}>
      <div className="editor-placeholder">
        {section === 'files' ? (
          <>
            <h2>Project files</h2>
            <p>
              Browse the Project directory in the file explorer. Selected files become available to
              Workflow Nodes as File References.
            </p>
            <p className="muted" data-testid="selected-file">
              {selectedFilePath ? `Selected: ${selectedFilePath}` : 'No file selected.'}
            </p>
          </>
        ) : null}

        {section === 'node-library' ? (
          <>
            <h2>Node Library</h2>
            <p>
              Nodes are discovered from installed Node Manifests. Each entry declares the ports,
              parameters, and scientific outputs it provides.
            </p>
            <p className="muted">No Node Manifests are installed in this Project yet.</p>
          </>
        ) : null}

        {section === 'runs' ? (
          <>
            <h2>Runs</h2>
            <p>
              Runs capture an immutable snapshot of the Workflow, parameters, File References, Node
              Manifests, and environment requirements used at start time.
            </p>
            <p className="muted">No Runs yet.</p>
            <button
              type="button"
              className="button button-outline"
              onClick={() => onNavigate('workflows')}
            >
              Back to Workflows
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
