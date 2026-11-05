import type { NodeManifest } from '@sflow/domain';
import { useEditorStore } from '../store/editor';
import { NodeLibrary } from './NodeLibrary';
import { WorkflowCanvas } from './WorkflowCanvas';

export interface WorkflowSurfaceProps {
  manifests: readonly NodeManifest[];
  onValidate: () => void;
  onRun: () => void;
  onNotify: (message: string) => void;
}

/**
 * Workflow tab strip, operation toolbar, canvas, and Node Library. The toolbar
 * remains present in maximize; Validate and Run stay visibly disabled
 * placeholders until ticket #6 supplies real operations.
 */
export function WorkflowSurface({
  manifests,
  onValidate,
  onRun,
  onNotify,
}: WorkflowSurfaceProps) {
  const draftName = useEditorStore((state) => state.draftName);
  const saveState = useEditorStore((state) => state.saveState);
  const selectedNodeId = useEditorStore((state) => state.layout.selection.nodeId);
  const maximize = useEditorStore((state) => state.maximize);
  const setLibraryOpen = useEditorStore((state) => state.setLibraryOpen);
  const setMaximize = useEditorStore((state) => state.setMaximize);
  const duplicateSelectedNode = useEditorStore((state) => state.duplicateSelectedNode);

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved'
        : saveState === 'error'
          ? 'Save failed'
          : '';

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
        <span className="workflow-save-state" data-testid="workflow-save-state">
          {saveLabel}
        </span>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="open-node-library"
          onClick={() => setLibraryOpen(true)}
        >
          Insert Node
        </button>
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="duplicate-node"
          disabled={!selectedNodeId}
          onClick={() => duplicateSelectedNode()}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="validate-workflow"
          onClick={onValidate}
        >
          Validate
        </button>
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="run-workflow"
          onClick={onRun}
        >
          Run
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="button button-sm button-ghost"
          data-testid="toggle-maximize"
          aria-label={maximize ? 'Exit canvas maximize' : 'Maximize canvas'}
          aria-pressed={maximize}
          onClick={() => setMaximize(!maximize)}
        >
          {maximize ? 'Exit maximize' : 'Maximize'}
        </button>
      </div>

      <WorkflowCanvas manifests={manifests} onNotify={onNotify} />
      <NodeLibrary manifests={manifests} />
    </>
  );
}
