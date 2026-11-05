import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileReference, Project } from '@sflow/domain';
import {
  ApiError,
  getWorkflow,
  listFileReferences,
  registerFileReference,
  saveWorkflow,
} from '../api';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useLayoutStore } from '../store/layout';
import { AgentPanel } from './AgentPanel';
import { FileExplorer } from './FileExplorer';
import { GlobalToolbar } from './GlobalToolbar';
import { PrimaryNav, type WorkspaceSection } from './PrimaryNav';
import { ResizeHandle } from './ResizeHandle';
import { RunMonitor } from './RunMonitor';
import { SettingsDialog } from './SettingsDialog';
import { WorkflowSurface } from './WorkflowSurface';
import { SectionSurface } from './SectionSurface';

export const WORKFLOW_DRAFT_ID = 'binder-design';

export interface DraftState {
  name: string;
  workflow: Record<string, unknown>;
  layout: Record<string, unknown>;
}

const EMPTY_DRAFT: DraftState = {
  name: 'Binder design',
  workflow: { version: 1, nodes: [], edges: [] },
  layout: {},
};

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface WorkspaceProps {
  project: Project;
  onSignedOut: () => void;
}

/**
 * Fixed-viewport Project workspace: global toolbar, product navigation, file
 * explorer, editor/monitor stack, and Agent surface. Panel geometry lives in
 * the layout store and never enters the Workflow draft.
 */
export function Workspace({ project, onSignedOut }: WorkspaceProps) {
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('workflows');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedReference, setSelectedReference] = useState<FileReference | null>(null);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const selectedPathRef = useRef<string | null>(null);

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

  useEffect(() => {
    getWorkflow(WORKFLOW_DRAFT_ID)
      .then((saved) => {
        setDraft({
          name: saved.name,
          workflow: saved.workflow,
          layout: saved.layout,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return;
        notify('The Workflow draft could not be loaded.');
      });
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

  const save = useCallback(async () => {
    setSaveState('saving');
    try {
      const saved = await saveWorkflow(WORKFLOW_DRAFT_ID, {
        name: draft.name,
        workflow: draft.workflow,
        layout: draft.layout,
      });
      setDraft({ name: saved.name, workflow: saved.workflow, layout: saved.layout });
      setSaveState('saved');
      notify('Draft saved.');
    } catch {
      setSaveState('error');
      notify('The Workflow draft could not be saved.');
    }
  }, [draft, notify]);

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
    <div className="app-shell" data-testid="app-shell">
      <GlobalToolbar
        project={project}
        draftName={draft.name}
        saveState={saveState}
        onSave={() => void save()}
        onRun={() => notify('Run creation is not available yet.')}
      />

      <div className="workspace-main">
        <PrimaryNav
          active={activeSection}
          onChange={setActiveSection}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {explorerCollapsed ? explorerRail : null}
        {!explorerCollapsed ? (
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
                draftName={draft.name}
                onNavigate={setActiveSection}
                onValidate={() => notify('Workflow validation is not available yet.')}
              />
            ) : (
              <SectionSurface
                section={activeSection}
                selectedFilePath={selectedFilePath}
                selectedReference={selectedReference}
                fileReferences={fileReferences}
                onNavigate={setActiveSection}
              />
            )}
          </div>
          <RunMonitor />
        </main>

        {!agentCollapsed ? (
          <>
            <ResizeHandle
              label="Resize agent panel"
              orientation="left"
              testId="agent-resizer"
              onResizeBy={resizeAgentBy}
            />
            <AgentPanel width={agentWidth} onCollapse={toggleAgent} />
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
