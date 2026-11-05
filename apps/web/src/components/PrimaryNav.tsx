export type WorkspaceSection = 'files' | 'workflows' | 'node-library' | 'terminal' | 'runs';

const NAV_ITEMS: Array<{ id: WorkspaceSection; label: string }> = [
  { id: 'files', label: 'Files' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'node-library', label: 'Node Library' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'runs', label: 'Runs' },
];

export interface PrimaryNavProps {
  active: WorkspaceSection;
  onChange: (section: WorkspaceSection) => void;
  onOpenSettings: () => void;
}

/** Stable entry points for the major Project capabilities. */
export function PrimaryNav({ active, onChange, onOpenSettings }: PrimaryNavProps) {
  return (
    <nav className="primary-nav" aria-label="Project" data-testid="primary-nav">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="nav-item"
          aria-current={active === item.id ? 'page' : undefined}
          data-testid={`nav-${item.id}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}

      <div className="nav-section">
        <button
          type="button"
          className="nav-item"
          data-testid="open-settings"
          onClick={onOpenSettings}
        >
          Project settings
        </button>
      </div>
    </nav>
  );
}
