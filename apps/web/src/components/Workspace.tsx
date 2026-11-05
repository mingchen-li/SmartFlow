import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEmptyEditorLayout,
  createEmptyWorkflow,
  EditorLayoutSchema,
  WorkflowIRSchema,
  type FileReference,
  type NodeManifest,
  type Project,
  type Run,
  type ValidateWorkflowResponse,
  type ValidationDiagnostic,
} from '@sflow/domain';
import {
  ApiError,
  createRun,
  getWorkflow,
  listFileReferences,
  listNodeManifests,
  listRuns,
  registerFileReference,
  validateWorkflowDraft,
} from '../api';
import { useDraftAutosave } from '../editor/useDraftAutosave';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useEditorStore } from '../store/editor';
import { useLayoutStore } from '../store/layout';
import { AgentPanel } from './AgentPanel';
import { FileExplorer } from './FileExplorer';
import { GlobalToolbar } from './GlobalToolbar';
import { PrimaryNav, type WorkspaceSection } from './PrimaryNav';
import { ResizeHandle } from './ResizeHandle';
import { RunMonitor } from './RunMonitor';
import { SectionSurface } from './SectionSurface';
import { SettingsDialog } from './SettingsDialog';
import { TerminalSurface } from './TerminalSurface';
import { WorkflowSurface } from './WorkflowSurface';

export const WORKFLOW_DRAFT_ID = 'binder-design';

export interface WorkspaceProps {
  project: Project;
  onSignedOut: () => void;
}

/**
 * Fixed-viewport Project workspace: global toolbar, product navigation, file
 * explorer, editor/monitor stack, and Agent surface. Workflow IR and
 * EditorLayout are persisted with the draft; panel geometry, maximize mode,
 * Node Library state, and selection presentation are app state outside it.
 */
export function Workspace({ project, onSignedOut }: WorkspaceProps) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('workflows');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedReference, setSelectedReference] = useState<FileReference | null>(null);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [manifests, setManifests] = useState<NodeManifest[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidateWorkflowResponse | null>(null);
  const [validatedSignature, setValidatedSignature] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [latestRun, setLatestRun] = useState<Run | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const wasMaximizedRef = useRef(false);

  const draftName = useEditorStore((state) => state.draftName);
  const saveState = useEditorStore((state) => state.saveState);
  const maximize = useEditorStore((state) => state.maximize);
  const workflow = useEditorStore((state) => state.workflow);
  const hydrate = useEditorStore((state) => state.hydrate);
  const setLibraryOpen = useEditorStore((state) => state.setLibraryOpen);

  // Validation is tied to Workflow content only, so layout edits (selection,
  // position, viewport) never invalidate a passing result.
  const workflowSignature = useMemo(() => JSON.stringify(workflow), [workflow]);
  const validationCurrent =
    validation !== null && validatedSignature === workflowSignature;
  const canRun =
    validationCurrent &&
    validation.valid &&
    !validating &&
    !startingRun;

  const agentWidth = useLayoutStore((state) => state.agentWidth);
  const explorerCollapsed = useLayoutStore((state) => state.explorerCollapsed);
  const agentCollapsed = useLayoutStore((state) => state.agentCollapsed);
  const resizeExplorerBy = useLayoutStore((state) => state.resizeExplorerBy);
  const resizeAgentBy = useLayoutStore((state) => state.resizeAgentBy);
  const setExplorerCollapsed = useLayoutStore((state) => state.setExplorerCollapsed);
  const setAgentCollapsed = useLayoutStore((state) => state.setAgentCollapsed);
  const toggleExplorer = useLayoutStore((state) => state.toggleExplorer);
  const toggleAgent = useLayoutStore((state) => state.toggleAgent);

  const narrow = useMediaQuery('(max-width: 899px)');
  const veryNarrow = useMediaQuery('(max-width: 719px)');

  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);

  const handleAutosaved = useCallback(() => notify('Draft saved.'), [notify]);
  const handleAutosaveError = useCallback(
    () => notify('The Workflow draft could not be saved.'),
    [notify],
  );

  const { saveNow } = useDraftAutosave({
    draftId: WORKFLOW_DRAFT_ID,
    onSaved: handleAutosaved,
    onError: handleAutosaveError,
  });

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  // Responsive fallback: the explorer yields first, then the Agent. The
  // primary editor is never collapsed by the shell.
  useEffect(() => {
    setExplorerCollapsed(narrow);
  }, [narrow, setExplorerCollapsed]);

  useEffect(() => {
    setAgentCollapsed(veryNarrow);
  }, [veryNarrow, setAgentCollapsed]);

  // Hydrate the editor document from the persisted draft. Unknown or older
  // layouts fall back safely; a 404 starts a new draft.
  useEffect(() => {
    let cancelled = false;

    getWorkflow(WORKFLOW_DRAFT_ID)
      .then((saved) => {
        if (cancelled) return;
        const workflow = WorkflowIRSchema.safeParse(saved.workflow);
        const layout = EditorLayoutSchema.safeParse(saved.layout);
        hydrate({
          name: saved.name,
          workflow: workflow.success ? workflow.data : createEmptyWorkflow(),
          layout: layout.success ? layout.data : createEmptyEditorLayout(),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!(error instanceof ApiError && error.status === 404)) {
          notify('The Workflow draft could not be loaded.');
        }
        hydrate({
          name: 'Binder design',
          workflow: createEmptyWorkflow(),
          layout: createEmptyEditorLayout(),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [hydrate, notify]);

  useEffect(() => {
    listNodeManifests()
      .then((response) => setManifests([...response.nodes]))
      .catch(() => notify('Node Manifests could not be loaded.'));
  }, [notify]);

  useEffect(() => {
    listFileReferences()
      .then((response) => {
        setFileReferences((current) => {
          const byPath = new Map(current.map((reference) => [reference.path, reference]));
          for (const reference of response.references) {
            if (!byPath.has(reference.path)) byPath.set(reference.path, reference);
          }
          return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
        });
      })
      .catch(() => notify('File References could not be loaded.'));
  }, [notify]);

  // Show the persisted Run history after reload; Run execution belongs to the
  // Orchestrator, so the monitor only reports the latest stored state.
  useEffect(() => {
    let cancelled = false;
    listRuns()
      .then((response) => {
        if (!cancelled) setLatestRun(response.runs[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) notify('Run history could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // App-level maximize, not the browser Fullscreen API. Escape exits and the
  // toolbar toggle regains focus.
  useEffect(() => {
    if (!maximize) {
      if (wasMaximizedRef.current) {
        wasMaximizedRef.current = false;
        document
          .querySelector<HTMLElement>('[data-testid="toggle-maximize"]')
          ?.focus();
      }
      return;
    }

    wasMaximizedRef.current = true;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (useEditorStore.getState().libraryOpen) return;
      event.preventDefault();
      useEditorStore.getState().setMaximize(false);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [maximize]);

  /**
   * Selecting a file records a path-backed File Reference. The source bytes
   * stay in the Project filesystem; only the location is registered.
   */
  const selectFile = useCallback(
    (path: string) => {
      selectedPathRef.current = path;
      setSelectedFilePath(path);

      registerFileReference(path)
        .then((reference) => {
          if (selectedPathRef.current !== path) return;
          setSelectedReference(reference);
          setFileReferences((current) => {
            const next = current.filter(
              (item) => item.id !== reference.id && item.path !== reference.path,
            );
            return [...next, reference].sort((a, b) => a.path.localeCompare(b.path));
          });
        })
        .catch(() => {
          if (selectedPathRef.current !== path) return;
          setSelectedReference(null);
          notify('The File Reference could not be registered.');
        });
    },
    [notify],
  );

  const changeSection = useCallback(
    (section: WorkspaceSection) => {
      if (section === 'node-library') {
        setLibraryOpen(true);
        return;
      }
      useEditorStore.getState().setMaximize(false);
      setActiveSection(section);
    },
    [setLibraryOpen],
  );

  const saveDraft = useCallback(() => {
    void saveNow({ notify: true });
  }, [saveNow]);

  /**
   * Validates the persisted draft. The content signature pins the result to
   * the exact Workflow that was checked so later edits disable Run.
   */
  const validateDraft = useCallback(async (): Promise<ValidateWorkflowResponse | null> => {
    if (validating) return null;

    const signature = JSON.stringify(useEditorStore.getState().workflow);
    setValidating(true);
    try {
      const saved = await saveNow();
      if (!saved) {
        notify('The Workflow draft could not be saved before validation.');
        return null;
      }

      const result = await validateWorkflowDraft(WORKFLOW_DRAFT_ID);
      setValidation(result);
      setValidatedSignature(signature);

      if (result.valid) {
        notify('Workflow is valid.');
      } else {
        const errors = result.diagnostics.filter(
          (diagnostic) => diagnostic.severity === 'error',
        ).length;
        notify(`${errors} validation error${errors === 1 ? '' : 's'} found.`);
      }
      return result;
    } catch (error) {
      notify(
        error instanceof Error
          ? `The Workflow could not be validated: ${error.message}`
          : 'The Workflow could not be validated.',
      );
      return null;
    } finally {
      setValidating(false);
    }
  }, [notify, saveNow, validating]);

  /** Re-validates before every Run; the server independently re-checks too. */
  const startRun = useCallback(async () => {
    if (startingRun) return;
    setStartingRun(true);
    try {
      const result = await validateDraft();
      if (!result?.valid) return;

      const { run } = await createRun(WORKFLOW_DRAFT_ID);
      setLatestRun(run);
      notify(`Run ${run.id} queued.`);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'VALIDATION_FAILED'
      ) {
        const details = error.details as
          | { diagnostics?: ValidationDiagnostic[] }
          | undefined;
        if (details?.diagnostics) {
          setValidation({ valid: false, diagnostics: details.diagnostics });
          setValidatedSignature(JSON.stringify(useEditorStore.getState().workflow));
        }
        notify('The Workflow does not pass validation. Correct the diagnostics and try again.');
      } else {
        notify(
          error instanceof Error
            ? `The Run could not be started: ${error.message}`
            : 'The Run could not be started.',
        );
      }
    } finally {
      setStartingRun(false);
    }
  }, [notify, startingRun, validateDraft]);

  const explorerRail = useMemo(
    () => (
      <div className="panel-rail" data-testid="explorer-rail">
        <button
          type="button"
          className="button button-ghost button-icon"
          aria-label="Expand file explorer"
          onClick={toggleExplorer}
        >
          ›
        </button>
        <span className="panel-rail-label">Files</span>
      </div>
    ),
    [toggleExplorer],
  );

  const agentRail = useMemo(
    () => (
      <div className="panel-rail agent-rail" data-testid="agent-rail">
        <button
          type="button"
          className="button button-ghost button-icon"
          aria-label="Expand agent panel"
          onClick={toggleAgent}
        >
          ‹
        </button>
        <span className="panel-rail-label">Agent</span>
      </div>
    ),
    [toggleAgent],
  );

  return (
    <div
      className={`app-shell${maximize ? ' app-shell-maximized' : ''}`}
      data-testid="app-shell"
      data-maximized={maximize ? 'true' : 'false'}
    >
      <GlobalToolbar
        project={project}
        draftName={draftName}
        saveState={saveState}
        onSave={saveDraft}
        onRun={() => void startRun()}
        runDisabled={!canRun}
        runPending={startingRun}
      />

      <div className="workspace-main">
        {!maximize ? (
          <PrimaryNav
            active={activeSection}
            onChange={changeSection}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : null}

        {!maximize && explorerCollapsed ? explorerRail : null}
        {!maximize && !explorerCollapsed ? (
          <>
            <FileExplorer
              selectedPath={selectedFilePath}
              onSelect={selectFile}
              onCollapse={toggleExplorer}
            />
            <ResizeHandle
              label="Resize file explorer"
              testId="explorer-resizer"
              onResizeBy={resizeExplorerBy}
            />
          </>
        ) : null}

        <main className="panel editor-panel" data-testid="editor-panel">
          <div className="editor-stack">
            {activeSection === 'workflows' ? (
              <WorkflowSurface
                manifests={manifests}
                onValidate={() => void validateDraft()}
                onRun={() => void startRun()}
                onNotify={notify}
                validation={validation}
                validating={validating}
                validationStale={validation !== null && !validationCurrent}
                canRun={canRun}
                runPending={startingRun}
              />
            ) : activeSection === 'terminal' ? (
              <TerminalSurface />
            ) : (
              <SectionSurface
                section={activeSection}
                selectedFilePath={selectedFilePath}
                selectedReference={selectedReference}
                fileReferences={fileReferences}
                onNavigate={changeSection}
              />
            )}
          </div>
          <RunMonitor run={latestRun} />
        </main>

        {!agentCollapsed ? (
          <>
            <ResizeHandle
              label="Resize agent panel"
              orientation="left"
              testId="agent-resizer"
              onResizeBy={resizeAgentBy}
            />
            <AgentPanel
              width={agentWidth}
              onCollapse={toggleAgent}
              manifests={manifests}
              fileReferences={fileReferences}
            />
          </>
        ) : null}
        {agentCollapsed ? agentRail : null}
      </div>

      {settingsOpen ? (
        <SettingsDialog
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSignedOut={onSignedOut}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" data-testid="toast">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
