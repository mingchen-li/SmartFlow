import type { FileReference } from '@sflow/domain';
import type { WorkspaceSection } from './PrimaryNav';

export interface SectionSurfaceProps {
  section: Exclude<WorkspaceSection, 'workflows' | 'terminal'>;
  selectedFilePath: string | null;
  selectedReference: FileReference | null;
  fileReferences: FileReference[];
  onNavigate: (section: WorkspaceSection) => void;
}

/**
 * Non-canvas workspace sections. Later tickets replace these placeholders with
 * the file-backed Workflow browser, Node Library, and Run history.
 */
export function SectionSurface({
  section,
  selectedFilePath,
  selectedReference,
  fileReferences,
  onNavigate,
}: SectionSurfaceProps) {
  return (
    <div className="editor-surface" data-testid={`section-${section}`}>
      <div className="editor-placeholder">
        {section === 'files' ? (
          <>
            <h2>Project files</h2>
            <p>
              Browse the Project directory in the file explorer. Selecting a file registers a
              path-backed File Reference that Workflow Nodes can use as an input.
            </p>

            {selectedReference && selectedReference.path === selectedFilePath ? (
              <div className="reference-details" data-testid="file-reference-details">
                <dl className="reference-grid">
                  <dt>File Reference</dt>
                  <dd data-testid="file-reference-path">{selectedReference.path}</dd>
                  <dt>Reference id</dt>
                  <dd data-testid="file-reference-id">{selectedReference.id}</dd>
                  <dt>Size</dt>
                  <dd>{selectedReference.size} bytes</dd>
                </dl>
                <p className="muted">Path-only reference: SFlow did not copy or hash this file.</p>
              </div>
            ) : (
              <p className="muted" data-testid="selected-file">
                {selectedFilePath ? `Selected: ${selectedFilePath}` : 'No file selected.'}
              </p>
            )}

            {fileReferences.length > 0 ? (
              <section aria-label="Registered File References">
                <h3 className="section-title">Registered File References</h3>
                <ul className="reference-list" data-testid="file-reference-list">
                  {fileReferences.map((reference) => (
                    <li key={reference.id}>
                      <code data-testid={`file-reference-${reference.path}`}>
                        {reference.path}
                      </code>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
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
