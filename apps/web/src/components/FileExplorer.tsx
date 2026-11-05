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

/** Read-only Project filesystem browser. `.sflow/` is never listed. */
export function FileExplorer({ selectedPath, onSelect, onCollapse }: FileExplorerProps) {
  const width = useLayoutStore((state) => state.explorerWidth);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState<ExplorerStatus>('loading');

  const load = useCallback(async (nextPath: string) => {
    setStatus('loading');
    try {
      const response = await listFiles(nextPath);
      setEntries(response.entries);
      setPath(response.path);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  function openDirectory(entry: FileEntry): void {
    void load(entry.path);
  }

  function goUp(): void {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    void load(parent);
  }

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
            onClick={() => void load(path)}
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

      <div className="panel-body">
        {path ? (
          <div className="explorer-path">
            <button type="button" className="button button-ghost button-sm" onClick={goUp}>
              ↑ Up
            </button>
            <span className="muted">{path}/</span>
          </div>
        ) : (
          <p className="empty-state">Project root</p>
        )}

        {status === 'loading' ? <p className="empty-state">Loading files…</p> : null}
        {status === 'error' ? (
          <p className="error-text" role="alert">
            The Project files could not be listed.
          </p>
        ) : null}
        {status === 'ready' && entries.length === 0 ? (
          <p className="empty-state">This directory is empty.</p>
        ) : null}

        {status === 'ready' && entries.length > 0 ? (
          <ul className="file-tree">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="file-entry"
                  aria-pressed={entry.type === 'file' ? selectedPath === entry.path : undefined}
                  onClick={() =>
                    entry.type === 'directory' ? openDirectory(entry) : onSelect(entry.path)
                  }
                >
                  <span className="file-kind">
                    {entry.type === 'directory' ? 'DIR' : 'FILE'}
                  </span>
                  <span>{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
