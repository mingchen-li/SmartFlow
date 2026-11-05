import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeManifest } from '@sflow/domain';
import { ALL_CATEGORY_ID, buildCatalog, filterCatalog } from '../editor/catalog';
import { useEditorStore } from '../store/editor';

export interface NodeLibraryProps {
  manifests: readonly NodeManifest[];
}

/**
 * Node Library modal. Categories, counts, search results, and the empty state
 * all derive from Node Manifest metadata. Insertion creates a configured Node
 * instance and selects it; the query and category are runtime UI state only.
 */
export function NodeLibrary({ manifests }: NodeLibraryProps) {
  const open = useEditorStore((state) => state.libraryOpen);
  const setLibraryOpen = useEditorStore((state) => state.setLibraryOpen);
  const insertManifest = useEditorStore((state) => state.insertManifest);

  const [category, setCategory] = useState(ALL_CATEGORY_ID);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const catalog = useMemo(() => buildCatalog(manifests), [manifests]);
  const results = useMemo(
    () => filterCatalog(manifests, category, query),
    [category, manifests, query],
  );

  useEffect(() => {
    if (!open) return;

    setCategory(ALL_CATEGORY_ID);
    setQuery('');
    searchRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        setLibraryOpen(false);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setLibraryOpen]);

  if (!open) return null;

  function close(): void {
    setLibraryOpen(false);
  }

  function insert(manifest: NodeManifest): void {
    insertManifest(manifest);
    setLibraryOpen(false);
  }

  const resultLabel = `${results.length} ${results.length === 1 ? 'Node' : 'Nodes'}`;

  return (
    <div
      className="node-library-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="node-library"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-library-title"
        data-testid="node-library"
      >
        <header className="node-library-header">
          <div>
            <h2 className="node-library-title" id="node-library-title">
              Node Library
            </h2>
            <p className="node-library-subtitle">
              Insert a Node configured from its Manifest. Every instance can be edited on the
              canvas.
            </p>
          </div>
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Close Node Library"
            data-testid="node-library-close"
            onClick={close}
          >
            ×
          </button>
        </header>

        <div className="node-library-search-row">
          <label className="sr-only" htmlFor="node-library-search">
            Search Nodes
          </label>
          <input
            ref={searchRef}
            id="node-library-search"
            className="input"
            type="search"
            placeholder="Search Nodes by name, description, or type…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="node-library-search"
            autoFocus
          />
          <span className="node-library-result-count" data-testid="node-library-result-count">
            {resultLabel}
          </span>
        </div>

        <div className="node-library-body">
          <nav className="node-library-categories" aria-label="Node categories">
            {catalog.map((item) => (
              <button
                key={item.id}
                type="button"
                className="node-library-category"
                aria-pressed={category === item.id}
                data-testid={`node-library-category-${item.id}`}
                onClick={() => setCategory(item.id)}
              >
                <span>{item.label}</span>
                <span
                  className="node-library-count"
                  data-testid={`node-library-count-${item.id}`}
                >
                  {item.count}
                </span>
              </button>
            ))}
          </nav>

          <div className="node-library-results">
            {manifests.length === 0 ? (
              <div className="node-library-empty" data-testid="node-library-empty">
                <strong>No Node Manifests are installed in this Project.</strong>
                <span>Install a Nodes package to populate the catalog.</span>
              </div>
            ) : results.length === 0 ? (
              <div className="node-library-empty" data-testid="node-library-empty">
                <strong>No matching Nodes</strong>
                <span>Try another keyword or category.</span>
              </div>
            ) : (
              <ul className="node-library-grid" aria-label="Node catalog">
                {results.map((manifest) => (
                  <li key={`${manifest.id}@${manifest.version}`}>
                    <button
                      type="button"
                      className="node-library-card"
                      data-testid={`node-library-node-${manifest.id}`}
                      onClick={() => insert(manifest)}
                    >
                      <span className="node-library-card-heading">
                        <span className="node-library-card-name">{manifest.name}</span>
                        <span className="badge badge-neutral">{manifest.type}</span>
                      </span>
                      <span className="node-library-card-category">{manifest.category}</span>
                      <span className="node-library-card-description">
                        {manifest.description}
                      </span>
                      <span className="node-library-card-meta">
                        {manifest.inputs.length} in · {manifest.outputs.length} out ·{' '}
                        {manifest.parameters.length} parameters
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
