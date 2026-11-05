import { useState } from 'react';

type MonitorTab = 'logs' | 'jobs' | 'outputs';

const MONITOR_TABS: Array<{ id: MonitorTab; label: string; empty: string }> = [
  { id: 'logs', label: 'Logs', empty: 'No Run or Task logs yet.' },
  { id: 'jobs', label: 'Jobs', empty: 'No scheduler Jobs yet.' },
  { id: 'outputs', label: 'Outputs', empty: 'No output files yet.' },
];

/**
 * Run monitor stays visible across workspace sections. Cards use an auto-fit
 * grid so they stack or scroll at narrow widths instead of disappearing.
 */
export function RunMonitor() {
  const [tab, setTab] = useState<MonitorTab>('logs');
  const activeTab = MONITOR_TABS.find((item) => item.id === tab) ?? MONITOR_TABS[0];

  return (
    <section className="run-monitor" aria-label="Run monitor" data-testid="run-monitor">
      <header className="run-monitor-header">
        <span>Run monitor</span>
        <span className="badge badge-neutral">Idle</span>
      </header>

      <div className="run-monitor-tabs" role="tablist" aria-label="Run monitor views">
        {MONITOR_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === item.id}
            data-testid={`monitor-tab-${item.id}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="run-monitor-body" role="tabpanel">
        <div className="monitor-cards" data-testid="monitor-cards">
          <article className="card">
            <div className="card-header">
              <span className="card-title">Run state</span>
              <span className="badge badge-neutral">Idle</span>
            </div>
            <div className="card-value">Idle</div>
            <div className="muted">No active Run.</div>
          </article>
          <article className="card">
            <div className="card-header">
              <span className="card-title">Tasks</span>
              <span className="badge badge-neutral">0</span>
            </div>
            <div className="card-value">0</div>
            <div className="muted">No queued or running Tasks.</div>
          </article>
          <article className="card">
            <div className="card-header">
              <span className="card-title">Resources</span>
              <span className="badge badge-neutral">Idle</span>
            </div>
            <div className="card-value">0 CPU · 0 GPU</div>
            <div className="muted">Nothing reserved.</div>
          </article>
        </div>
        <p className="monitor-placeholder" data-testid="monitor-empty">
          {activeTab.empty}
        </p>
      </div>
    </section>
  );
}
