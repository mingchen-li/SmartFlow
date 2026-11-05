import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '@sflow/domain';
import { listFiles } from '../api';
import { useLayoutStore } from '../store/layout';

export interface FileExplorerProps {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onCollapse: () => void;
}

type ExplorerStatus = 'loading' | 'ready' | 'error';

interface DirectoryState {
  entries: FileEntry[];
  status: ExplorerStatus;
}

/**
 * Expandable, read-only Project filesystem tree. Directories open in place
 * instead of navigating, selection is owned by the workspace, and the tree
 * owns its vertical scroll so the Workflow editor never moves. `.sflow/` is
 * never listed.
 */
export function FileExplorer({ selectedPath, onSelect, onCollapse }: FileExplorerProps) {
  const width = useLayoutStore((state) => state.explorerWidth);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async (path: string) => {
    setDirectories((current) => ({
      ...current,
      [path]: { entries: current[path]?.entries ?? [], status: 'loading' },
    }));

    try {
      const response = await listFiles(path);
      setDirectories((current) => ({
        ...current,
        [path]: { entries: response.entries, status: 'ready' },
      }));
    } catch {
      setDirectories((current) => ({
        ...current,
        [path]: { entries: current[path]?.entries ?? [], status: 'error' },
      }));
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  function toggleDirectory(path: string): void {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpanded((current) => new Set(current).add(path));
    if (directories[path]?.status !== 'ready' && directories[path]?.status !== 'loading') {
      void load(path);
    }
  }

  function refresh(): void {
    void load('');
    for (const path of expanded) void load(path);
  }

  function renderEntries(parentPath: string, depth: number) {
    const state = directories[parentPath];
    if (!state) return null;

    if (state.status === 'loading' && state.entries.length === 0) {
      return <li className="empty-state">Loading files…</li>;
    }

    if (state.status === 'error') {
      return (
        <li className="error-text" role="alert">
          The files in this directory could not be listed.
        </li>
      );
    }

    if (state.entries.length === 0) {
      return <li className="empty-state">This directory is empty.</li>;
    }

    return state.entries.map((entry) => {
      const isDirectory = entry.type === 'directory';
      const isExpanded = isDirectory && expanded.has(entry.path);

      return (
        <li key={entry.path}>
          <button
            type="button"
            className="file-entry"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            data-testid={`file-entry-${entry.path}`}
            aria-expanded={isDirectory ? isExpanded : undefined}
            aria-pressed={isDirectory ? undefined : selectedPath === entry.path}
            onClick={() => (isDirectory ? toggleDirectory(entry.path) : onSelect(entry.path))}
          >
            <span className="file-kind" aria-hidden="true">
              {isDirectory ? (isExpanded ? '▾' : '▸') : 'FILE'}
            </span>
            <span className="file-name">{entry.name}</span>
          </button>

          {isDirectory && isExpanded ? (
            <ul className="file-tree file-tree-children">
              {renderEntries(entry.path, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  }

  const root = directories[''];

  return (
    <section
      className="panel file-explorer-panel"
      style={{ width }}
      aria-label="Project files"
      data-testid="explorer-panel"
    >
      <header className="panel-header">
        <span>Project files</span>
        <span className="panel-header-actions">
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Refresh files"
            onClick={refresh}
          >
            ↻
          </button>
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Collapse file explorer"
            onClick={onCollapse}
          >
            ‹
          </button>
        </span>
      </header>

      <div className="panel-body explorer-body">
        <div className="explorer-tree-scroll" data-testid="explorer-tree-scroll">
          {root === undefined || (root.status === 'loading' && root.entries.length === 0) ? (
            <p className="empty-state">Loading files…</p>
          ) : root.status === 'error' ? (
            <p className="error-text" role="alert">
              The Project files could not be listed.
            </p>
          ) : root.entries.length === 0 ? (
            <p className="empty-state">This Project directory is empty.</p>
          ) : (
            <ul className="file-tree">{renderEntries('', 0)}</ul>
          )}
        </div>

        <div className="explorer-selection">
          <span className="explorer-selection-label">Selected file</span>
          <span className="explorer-selection-path" data-testid="explorer-selected-path">
            {selectedPath ?? 'None'}
          </span>
          {selectedPath ? (
            <span className="explorer-selection-note">Path-only File Reference</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
