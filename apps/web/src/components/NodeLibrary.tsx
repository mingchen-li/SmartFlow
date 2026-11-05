import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { InstalledNode, NodeManifest } from '@sflow/domain';
import { ApiError, installNodePackage } from '../api';
import { ALL_CATEGORY_ID, buildCatalog, filterCatalog } from '../editor/catalog';
import { useEditorStore } from '../store/editor';

export interface NodeLibraryProps {
  manifests: readonly NodeManifest[];
  /** Project-installed packages, used to mark and describe custom Nodes. */
  installedNodes?: readonly InstalledNode[];
  /** Re-reads the Server catalog after a successful install. */
  onCatalogChanged?: () => void | Promise<void>;
}

interface InstallError {
  message: string;
  diagnostics: Array<{ path: string; message: string }>;
}

function manifestKey(manifest: Pick<NodeManifest, 'id' | 'version'>): string {
  return `${manifest.id}@${manifest.version}`;
}

/** Extracts path-addressed package diagnostics from a rejected install. */
function installErrorFrom(error: unknown): InstallError {
  if (error instanceof ApiError) {
    const details = error.details as
      | { diagnostics?: Array<{ path?: unknown; message?: unknown }> }
      | undefined;
    return {
      message: error.message,
      diagnostics: (details?.diagnostics ?? []).flatMap((entry) =>
        typeof entry.path === 'string' && typeof entry.message === 'string'
          ? [{ path: entry.path, message: entry.message }]
          : [],
      ),
    };
  }
  return {
    message:
      error instanceof Error ? error.message : 'The Node package could not be installed.',
    diagnostics: [],
  };
}

/**
 * Node Library modal. Categories, counts, search results, and the empty state
 * all derive from Node Manifest metadata. Insertion creates a configured Node
 * instance and selects it; the query and category are runtime UI state only.
 *
 * The same surface installs Project-scoped Node packages: a Project-relative
 * directory is submitted to the Server, validation diagnostics are shown in
 * place, and a successful install refreshes the catalog without a reload.
 */
export function NodeLibrary({
  manifests,
  installedNodes = [],
  onCatalogChanged,
}: NodeLibraryProps) {
  const open = useEditorStore((state) => state.libraryOpen);
  const setLibraryOpen = useEditorStore((state) => state.setLibraryOpen);
  const insertManifest = useEditorStore((state) => state.insertManifest);

  const [category, setCategory] = useState(ALL_CATEGORY_ID);
  const [query, setQuery] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [installPath, setInstallPath] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<InstallError | null>(null);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const catalog = useMemo(() => buildCatalog(manifests), [manifests]);
  const results = useMemo(
    () => filterCatalog(manifests, category, query),
    [category, manifests, query],
  );
  const installedByKey = useMemo(
    () => new Map(installedNodes.map((entry) => [manifestKey(entry.manifest), entry])),
    [installedNodes],
  );

  useEffect(() => {
    if (!open) return;

    setCategory(ALL_CATEGORY_ID);
    setQuery('');
    setInstallOpen(false);
    setInstallPath('');
    setInstallError(null);
    setInstallNotice(null);
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

  async function submitInstall(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const path = installPath.trim();
    if (!path || installing) return;

    setInstalling(true);
    setInstallError(null);
    setInstallNotice(null);
    try {
      const { node } = await installNodePackage(path);
      setInstallOpen(false);
      setInstallPath('');
      setInstallNotice(`Installed ${node.manifest.name} ${node.version}.`);
      try {
        await onCatalogChanged?.();
      } catch {
        // The package is already installed on the Server; the next catalog
        // read will surface it even if this refresh failed.
      }
    } catch (error) {
      setInstallError(installErrorFrom(error));
    } finally {
      setInstalling(false);
    }
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
              Insert a Node configured from its Manifest, or install a Project-scoped Node
              package.
            </p>
          </div>
          <div className="node-library-header-actions">
            <button
              type="button"
              className="button button-sm button-outline"
              aria-expanded={installOpen}
              data-testid="node-library-install-toggle"
              onClick={() => {
                setInstallError(null);
                setInstallNotice(null);
                setInstallOpen((current) => !current);
              }}
            >
              {installOpen ? 'Cancel install' : 'Install Node'}
            </button>
            <button
              type="button"
              className="button button-ghost button-icon"
              aria-label="Close Node Library"
              data-testid="node-library-close"
              onClick={close}
            >
              ×
            </button>
          </div>
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

        {installOpen ? (
          <form
            className="node-library-install"
            data-testid="node-library-install-form"
            onSubmit={(event) => void submitInstall(event)}
          >
            <label className="node-library-install-label" htmlFor="node-library-install-path">
              Project-relative package directory
            </label>
            <div className="node-library-install-row">
              <input
                id="node-library-install-path"
                className="input"
                value={installPath}
                placeholder="node-packages/my-node"
                spellCheck={false}
                data-testid="node-library-install-path"
                onChange={(event) => setInstallPath(event.target.value)}
              />
              <button
                type="submit"
                className="button button-sm button-primary"
                disabled={!installPath.trim() || installing}
                aria-busy={installing}
                data-testid="node-library-install-submit"
              >
                {installing ? 'Installing…' : 'Install'}
              </button>
            </div>
            <p className="node-library-install-hint">
              The directory must contain <code>manifest.json</code> and an <code>index.mjs</code>{' '}
              exporting <code>run(input, params, context)</code>.
            </p>
            {installError ? (
              <div
                className="node-library-install-error"
                role="alert"
                data-testid="node-library-install-error"
              >
                <strong>{installError.message}</strong>
                {installError.diagnostics.length > 0 ? (
                  <ul data-testid="node-library-install-diagnostics">
                    {installError.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.path}-${index}`}>
                        <code>{diagnostic.path}</code>
                        <span>{diagnostic.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </form>
        ) : null}

        {installNotice ? (
          <p
            className="node-library-install-notice"
            role="status"
            data-testid="node-library-install-notice"
          >
            {installNotice}
          </p>
        ) : null}

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
                {results.map((manifest) => {
                  const installed = installedByKey.get(manifestKey(manifest));
                  return (
                    <li key={manifestKey(manifest)}>
                      <button
                        type="button"
                        className="node-library-card"
                        data-testid={`node-library-node-${manifest.id}`}
                        onClick={() => insert(manifest)}
                      >
                        <span className="node-library-card-heading">
                          <span className="node-library-card-name">{manifest.name}</span>
                          <span className="node-library-card-badges">
                            {installed ? (
                              <span
                                className="badge badge-success"
                                data-testid={`node-library-installed-${manifest.id}`}
                                title={`Installed from ${installed.path}`}
                              >
                                Installed
                              </span>
                            ) : null}
                            <span className="badge badge-neutral">{manifest.type}</span>
                          </span>
                        </span>
                        <span className="node-library-card-category">
                          {manifest.category} · v{manifest.version}
                        </span>
                        <span className="node-library-card-description">
                          {manifest.description}
                        </span>
                        <span className="node-library-card-meta">
                          {manifest.inputs.length} in · {manifest.outputs.length} out ·{' '}
                          {manifest.parameters.length} parameters · {manifest.metrics.length}{' '}
                          Metrics
                        </span>
                        <span
                          className="node-library-card-environment"
                          title={manifest.environment.image}
                          data-testid={`node-library-environment-${manifest.id}`}
                        >
                          {manifest.environment.kind} · {manifest.environment.image} · retry{' '}
                          {manifest.retry.maxAttempts}
                        </span>
                        {installed ? (
                          <span
                            className="node-library-card-source"
                            data-testid={`node-library-source-${manifest.id}`}
                          >
                            {installed.path}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
