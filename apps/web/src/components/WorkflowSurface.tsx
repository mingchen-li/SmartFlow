import type {
  NodeManifest,
  ValidateWorkflowResponse,
} from '@sflow/domain';
import { useEditorStore } from '../store/editor';
import { NodeLibrary } from './NodeLibrary';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { CanvasRuntimeState } from './WorkflowNodeCard';
import { WorkflowValidationPanel } from './WorkflowValidationPanel';

export interface WorkflowSurfaceProps {
  manifests: readonly NodeManifest[];
  onValidate: () => void;
  onRun: () => void;
  onNotify: (message: string) => void;
  validation: ValidateWorkflowResponse | null;
  validating: boolean;
  validationStale: boolean;
  canRun: boolean;
  runPending: boolean;
  runtime?: CanvasRuntimeState | null;
}

/**
 * Workflow tab strip, operation toolbar, validation results, canvas, and Node
 * Library. The toolbar remains present in maximize; Run is only available when
 * the current Workflow content has passed validation.
 */
export function WorkflowSurface({
  manifests,
  onValidate,
  onRun,
  onNotify,
  validation,
  validating,
  validationStale,
  canRun,
  runPending,
  runtime = null,
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
          disabled={validating}
          aria-busy={validating}
          onClick={onValidate}
        >
          {validating ? 'Validating…' : 'Validate'}
        </button>
        <button
          type="button"
          className="button button-sm button-outline"
          data-testid="run-workflow"
          disabled={!canRun}
          aria-busy={runPending}
          title={canRun ? 'Start a Run from this Workflow' : 'Validate the Workflow before starting a Run'}
          onClick={onRun}
        >
          {runPending ? 'Starting…' : 'Run'}
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

      <WorkflowValidationPanel
        validation={validation}
        validating={validating}
        stale={validationStale}
      />
      <WorkflowCanvas manifests={manifests} onNotify={onNotify} runtime={runtime} />
      <NodeLibrary manifests={manifests} />
    </>
  );
}
