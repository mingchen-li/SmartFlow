import { useState } from 'react';
import type { Run, RunDetailResponse, Task } from '@sflow/domain';

type MonitorTab = 'logs' | 'jobs' | 'outputs';

const MONITOR_TABS: Array<{ id: MonitorTab; label: string; empty: string }> = [
  { id: 'logs', label: 'Logs', empty: 'No Run or Task logs yet.' },
  { id: 'jobs', label: 'Jobs', empty: 'No scheduler Jobs yet.' },
  { id: 'outputs', label: 'Outputs', empty: 'No output files yet.' },
];

function taskBadgeClass(state: Task['state']): string {
  switch (state) {
    case 'completed':
      return 'badge badge-success';
    case 'failed':
    case 'canceled':
      return 'badge badge-warning';
    default:
      return 'badge badge-info';
  }
}

export interface RunMonitorProps {
  /** Most recent Run, or null before the first Run starts. */
  run?: Run | null;
  /** Stored Tasks, Artifacts, and Metrics for the most recent Run. */
  detail?: RunDetailResponse | null;
  onCancel?: () => void;
  onRerun?: (task: Task) => void;
  actionPending?: boolean;
}

/**
 * Run monitor stays visible across workspace sections. Cards use an auto-fit
 * grid so they stack or scroll at narrow widths instead of disappearing. The
 * attempt history keeps every Task attempt and failure visible, including
 * attempts superseded by a retry or an explicit rerun.
 */
export function RunMonitor({
  run = null,
  detail = null,
  onCancel,
  onRerun,
  actionPending = false,
}: RunMonitorProps) {
  const [tab, setTab] = useState<MonitorTab>('logs');
  const activeTab = MONITOR_TABS.find((item) => item.id === tab) ?? MONITOR_TABS[0];
  const effectiveRun = detail?.run ?? run;
  const runStatus = effectiveRun?.status ?? 'Idle';
  const tasks = detail?.tasks ?? [];

  const nodeOrder = new Map(
    (effectiveRun?.snapshot.nodes ?? []).map((node, index) => [node.nodeId, index]),
  );
  const latestByNode = new Map<string, Task>();
  for (const task of tasks) {
    const current = latestByNode.get(task.nodeId);
    if (!current || task.attempt > current.attempt) latestByNode.set(task.nodeId, task);
  }
  const orderedTasks = [...tasks].sort((left, right) => {
    const order =
      (nodeOrder.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) -
      (nodeOrder.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER);
    return order !== 0 ? order : left.attempt - right.attempt;
  });
  const completed = tasks.filter((task) => task.state === 'completed').length;
  const active = tasks.filter(
    (task) => task.state === 'queued' || task.state === 'running',
  ).length;
  const canceled = tasks.filter((task) => task.state === 'canceled').length;
  const canCancel =
    effectiveRun !== null &&
    (effectiveRun.status === 'queued' || effectiveRun.status === 'running') &&
    onCancel !== undefined;

  return (
    <section className="run-monitor" aria-label="Run monitor" data-testid="run-monitor">
      <header className="run-monitor-header">
        <span>Run monitor</span>
        <span className="run-monitor-actions">
          {canCancel ? (
            <button
              type="button"
              className="button button-ghost"
              data-testid="cancel-run"
              disabled={actionPending}
              onClick={onCancel}
            >
              Cancel Run
            </button>
          ) : null}
          <span
            className={`badge ${effectiveRun ? 'badge-info' : 'badge-neutral'}`}
            data-testid="monitor-run-status"
          >
            {runStatus}
          </span>
        </span>
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
              <span className={`badge ${effectiveRun ? 'badge-info' : 'badge-neutral'}`}>
                {runStatus}
              </span>
            </div>
            <div className="card-value" data-testid="monitor-run-state">
              {runStatus}
            </div>
            <div className="muted" data-testid="monitor-run-id">
              {effectiveRun ? `Run ${effectiveRun.id}` : 'No active Run.'}
            </div>
          </article>
          <article className="card">
            <div className="card-header">
              <span className="card-title">Tasks</span>
              <span className="badge badge-neutral" data-testid="monitor-task-count">
                {tasks.length}
              </span>
            </div>
            <div className="card-value">{tasks.length}</div>
            <div className="muted">
              {tasks.length === 0
                ? 'No queued or running Tasks.'
                : `${completed} completed · ${active} active · ${canceled} canceled`}
            </div>
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

        {orderedTasks.length > 0 ? (
          <div className="attempt-history" data-testid="attempt-history">
            <div className="attempt-history-title">Attempts and failure history</div>
            <ol className="attempt-list">
              {orderedTasks.map((task) => {
                const label =
                  effectiveRun?.snapshot.nodes.find((node) => node.nodeId === task.nodeId)
                    ?.label ?? task.nodeId;
                const latest = latestByNode.get(task.nodeId)?.id === task.id;
                const canRerun =
                  latest &&
                  (task.state === 'failed' || task.state === 'canceled') &&
                  onRerun !== undefined;
                return (
                  <li
                    key={task.id}
                    className="attempt-row"
                    data-testid={`task-attempt-${task.id}`}
                    data-node-id={task.nodeId}
                    data-attempt={task.attempt}
                    data-state={task.state}
                    data-latest={latest ? 'true' : 'false'}
                  >
                    <span className="attempt-node">{label}</span>
                    <span className="badge badge-neutral">Attempt {task.attempt}</span>
                    <span className={taskBadgeClass(task.state)}>
                      {task.state}
                      {latest ? '' : ' (superseded)'}
                    </span>
                    {task.failureKind ? (
                      <span className="attempt-failure-kind">{task.failureKind}</span>
                    ) : null}
                    {task.error ? (
                      <span className="attempt-error" title={task.error}>
                        {task.error}
                      </span>
                    ) : null}
                    <span className="attempt-actions">
                      {task.logsAvailable ? <span className="muted">logs</span> : null}
                      {canRerun ? (
                        <button
                          type="button"
                          className="button button-ghost"
                          data-testid={`rerun-task-${task.id}`}
                          disabled={actionPending}
                          onClick={() => onRerun?.(task)}
                        >
                          Rerun
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <p className="monitor-placeholder" data-testid="monitor-empty">
            {activeTab.empty}
          </p>
        )}
      </div>
    </section>
  );
}
