import { useState } from 'react';
import type {
  Artifact,
  Metric,
  Run,
  RunDetailResponse,
  RunEvent,
  RunNodeSnapshot,
  Task,
  TaskState,
} from '@sflow/domain';
import { isActiveRunStatus } from '@sflow/domain';
import { artifactDownloadUrl } from '../api';
import { useTaskLogs } from '../hooks/useTaskLogs';

type MonitorTab = 'overview' | 'tasks' | 'resources' | 'logs' | 'results';

const MONITOR_TABS: Array<{ id: MonitorTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks / Slurm' },
  { id: 'resources', label: 'Resources' },
  { id: 'logs', label: 'Logs' },
  { id: 'results', label: 'Results' },
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
  /** Live Run detail (Tasks, Artifacts, Metrics) while the Run is observed. */
  detail?: RunDetailResponse | null;
  /** Append-only Run events already observed by the workspace. */
  events?: readonly RunEvent[];
  onOpenResultView?: (runId: string) => void;
  /** Cancels the active Run; completed science stays untouched. */
  onCancel?: () => void;
  /** Explicitly reruns the selected failed or canceled Task attempt. */
  onRerun?: (task: Task) => void;
  actionPending?: boolean;
}

function statusTone(status: string | null | undefined): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-destructive';
  if (status === 'queued' || status === 'running') return 'badge-info';
  return 'badge-neutral';
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const time = value.includes('T') ? value.split('T')[1] ?? value : value;
  return time.replace(/Z$/, '').slice(0, 8);
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} bytes`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
  return `${(size / 1_048_576).toFixed(1)} MiB`;
}

function eventLine(event: RunEvent): string {
  const payload =
    event.payload === undefined ? '' : ` ${JSON.stringify(event.payload)}`;
  return `#${event.id} ${formatTime(event.createdAt)} ${event.type}${
    event.taskId ? ` task=${event.taskId}` : ''
  }${payload}`;
}

function snapshotNodeLabel(
  nodes: readonly RunNodeSnapshot[],
  nodeId: string | undefined,
): string {
  return nodes.find((node) => node.nodeId === nodeId)?.label ?? nodeId ?? 'Unknown Node';
}

function taskResources(
  nodes: readonly RunNodeSnapshot[],
  task: Task,
): RunNodeSnapshot['resources'] | undefined {
  return nodes.find((node) => node.nodeId === task.nodeId)?.resources;
}

function TaskStateBadge({ task }: { task: Task }) {
  return (
    <span
      className={`badge ${statusTone(task.state)}`}
      data-testid={`monitor-task-state-${task.id}`}
      data-state={task.state}
    >
      {task.state}
    </span>
  );
}

function countTasks(tasks: readonly Task[]): Record<TaskState, number> {
  return {
    queued: tasks.filter((task) => task.state === 'queued').length,
    running: tasks.filter((task) => task.state === 'running').length,
    completed: tasks.filter((task) => task.state === 'completed').length,
    failed: tasks.filter((task) => task.state === 'failed').length,
    canceled: tasks.filter((task) => task.state === 'canceled').length,
  };
}

/**
 * Run monitor with five live views. Every Task state, log, resource
 * requirement, and output in these panels comes from Run detail and Run
 * events; presentation state never enters Workflow IR or EditorLayout. Cards
 * use an auto-fit grid and panels scroll internally so content stacks instead
 * of disappearing at narrow widths.
 *
 * The attempt history keeps every Task attempt and failure visible, including
 * attempts superseded by a retry or an explicit rerun. The header exposes
 * Cancel Run while the Run is active; failed or canceled latest attempts offer
 * an explicit Rerun.
 */
export function RunMonitor({
  run = null,
  detail = null,
  events = [],
  onOpenResultView,
  onCancel,
  onRerun,
  actionPending = false,
}: RunMonitorProps) {
  const [tab, setTab] = useState<MonitorTab>('overview');
  const effectiveRun = detail?.run ?? run;
  const runStatus = effectiveRun?.status ?? 'Idle';
  const active = effectiveRun ? isActiveRunStatus(effectiveRun.status) : false;
  const tasks = detail?.tasks ?? [];
  const artifacts = detail?.artifacts ?? [];
  const metrics = detail?.metrics ?? [];
  const snapshotNodes = effectiveRun?.snapshot.nodes ?? [];
  const counts = countTasks(tasks);
  const taskLogs = useTaskLogs(effectiveRun?.id ?? null, detail?.tasks);
  const completedPercent =
    tasks.length === 0 ? 0 : Math.round((counts.completed / tasks.length) * 100);

  const nodeOrder = new Map(
    snapshotNodes.map((node, index) => [node.nodeId, index]),
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
  const canCancel =
    effectiveRun !== null &&
    (effectiveRun.status === 'queued' || effectiveRun.status === 'running') &&
    onCancel !== undefined;

  const cpuReserved = tasks
    .filter((task) => task.state === 'running' || task.state === 'queued')
    .reduce((sum, task) => sum + (taskResources(snapshotNodes, task)?.cpu ?? 0), 0);

  return (
    <section
      className="run-monitor"
      aria-label="Run monitor"
      data-testid="run-monitor"
      data-run-status={effectiveRun?.status ?? 'idle'}
      data-active={active ? 'true' : 'false'}
    >
      <header className="run-monitor-header">
        <span>Run monitor</span>
        <span className="monitor-header-meta">
          {active ? <span className="monitor-live">Live</span> : null}
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
              className={`badge ${statusTone(effectiveRun?.status)}`}
              data-testid="monitor-run-status"
            >
              {runStatus}
            </span>
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
        {tab === 'overview' ? (
          <div data-testid="monitor-panel-overview">
            <div className="monitor-cards" data-testid="monitor-cards">
              <article className="card">
                <div className="card-header">
                  <span className="card-title">Run state</span>
                  <span className={`badge ${statusTone(effectiveRun?.status)}`}>{runStatus}</span>
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
                  <span className="badge badge-neutral">{tasks.length}</span>
                </div>
                <div className="card-value" data-testid="monitor-progress">
                  {counts.completed} / {tasks.length}
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-label="Completed Tasks"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(tasks.length, 1)}
                  aria-valuenow={counts.completed}
                  aria-valuetext={`${counts.completed} of ${tasks.length} Tasks completed`}
                  data-testid="monitor-progress-bar"
                >
                  <div
                    className="progress-fill"
                    data-testid="monitor-progress-fill"
                    style={{ width: `${completedPercent}%` }}
                  />
                </div>
                <p className="progress-value" data-testid="monitor-progress-percent">
                  {completedPercent}% complete
                </p>
                <div className="muted">
                  {counts.running} running · {counts.queued} queued · {counts.failed} failed
                </div>
              </article>
              <article className="card">
                <div className="card-header">
                  <span className="card-title">Resources</span>
                  <span className="badge badge-neutral">
                    {counts.running} running
                  </span>
                </div>
                <div className="card-value" data-testid="monitor-resource-summary">
                  {cpuReserved} CPU reserved
                </div>
                <div className="muted">
                  {effectiveRun ? 'Local Compute Executor' : 'Nothing reserved.'}
                </div>
              </article>
            </div>
            <p className="monitor-placeholder">
              {effectiveRun
                ? `${events.length} Run events observed · ${artifacts.length} output files · ${metrics.length} Metrics`
                : 'No Run yet. Validate the Workflow and start a Run to inspect it here.'}
            </p>

            {orderedTasks.length > 0 ? (
              <div className="attempt-history" data-testid="attempt-history">
                <div className="attempt-history-title">Attempts and failure history</div>
                <ol className="attempt-list">
                  {orderedTasks.map((task) => {
                    const label = snapshotNodeLabel(snapshotNodes, task.nodeId);
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
                No Task attempts yet.
              </p>
            )}
          </div>
        ) : null}

        {tab === 'tasks' ? (
          <div data-testid="monitor-panel-tasks">
            {tasks.length === 0 ? (
              <p className="monitor-placeholder">No Tasks yet.</p>
            ) : (
              <div className="monitor-scroll">
                <table className="monitor-table" data-testid="monitor-tasks">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>State</th>
                      <th>Attempt</th>
                      <th>Scheduler</th>
                      <th>Exit</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr key={task.id} data-testid={`monitor-task-${task.id}`}>
                        <td>{snapshotNodeLabel(snapshotNodes, task.nodeId)}</td>
                        <td>
                          <TaskStateBadge task={task} />
                        </td>
                        <td>{task.attempt}</td>
                        <td data-testid={`monitor-task-scheduler-${task.id}`}>
                          {task.jobId ? `Local · ${task.jobId}` : 'Local (Slurm not configured)'}
                        </td>
                        <td>{task.exitCode ?? '—'}</td>
                        <td>{formatTime(task.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {tab === 'resources' ? (
          <div data-testid="monitor-panel-resources">
            {effectiveRun ? (
              <>
                <p className="monitor-resource-usage" data-testid="monitor-resource-usage">
                  {counts.running} running · {counts.queued} queued · {cpuReserved} CPU reserved
                </p>
                <div className="monitor-scroll">
                  <table
                    className="monitor-table"
                    data-testid="monitor-resource-requirements"
                  >
                    <thead>
                      <tr>
                        <th>Node</th>
                        <th>CPU</th>
                        <th>GPU</th>
                        <th>Memory</th>
                        <th>Walltime</th>
                        <th>Image</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshotNodes.map((node) => (
                        <tr
                          key={node.nodeId}
                          data-testid={`monitor-resource-${node.nodeId}`}
                          data-cpu={node.resources.cpu ?? 0}
                        >
                          <td>{node.label}</td>
                          <td>{node.resources.cpu ?? 0}</td>
                          <td>{node.resources.gpu ?? 0}</td>
                          <td>{node.resources.memory ?? '—'}</td>
                          <td>
                            {node.resources.walltimeMinutes
                              ? `${node.resources.walltimeMinutes} min`
                              : '—'}
                          </td>
                          <td className="monitor-ellipsis">
                            {node.environment.image ?? node.environment.kind}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3 className="section-title">Task reservations</h3>
                {tasks.length === 0 ? (
                  <p className="monitor-placeholder">No Task reservations yet.</p>
                ) : (
                  <ul className="monitor-reservations">
                    {tasks.map((task) => {
                      const resources = taskResources(snapshotNodes, task);
                      return (
                        <li key={task.id} data-testid={`monitor-reservation-${task.id}`}>
                          <TaskStateBadge task={task} />{' '}
                          {snapshotNodeLabel(snapshotNodes, task.nodeId)} ·{' '}
                          {resources?.cpu ?? 0} CPU · {resources?.gpu ?? 0} GPU ·{' '}
                          {resources?.memory ?? '—'}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : (
              <p className="monitor-placeholder">No resources reserved.</p>
            )}
          </div>
        ) : null}

        {tab === 'logs' ? (
          <div data-testid="monitor-panel-logs">
            {effectiveRun ? (
              <div className="monitor-log-grid">
                <section className="monitor-log-section">
                  <h3 className="section-title">Run events</h3>
                  <pre className="log-pane" data-testid="monitor-events-log">
                    {events.length === 0
                      ? 'No Run events yet.'
                      : events.map(eventLine).join('\n')}
                  </pre>
                </section>
                {tasks.map((task) => (
                  <section className="monitor-log-section" key={task.id}>
                    <h3 className="section-title">
                      {snapshotNodeLabel(snapshotNodes, task.nodeId)}{' '}
                      <span className="muted">attempt {task.attempt}</span>
                    </h3>
                    <pre className="log-pane" data-testid={`monitor-task-log-${task.id}`}>
                      {task.logsAvailable
                        ? (taskLogs[task.id]?.lines.join('\n') ?? 'Loading Task logs…')
                        : 'No log file available.'}
                    </pre>
                  </section>
                ))}
                {tasks.length === 0 ? (
                  <p className="monitor-placeholder">No Task logs yet.</p>
                ) : null}
              </div>
            ) : (
              <p className="monitor-placeholder">No Run or Task logs yet.</p>
            )}
          </div>
        ) : null}

        {tab === 'results' ? (
          <div data-testid="monitor-panel-results">
            <div className="monitor-results">
              <section className="monitor-results-section">
                <h3 className="section-title">Output files</h3>
                {artifacts.length === 0 ? (
                  <p className="monitor-placeholder">No output files yet.</p>
                ) : (
                  <ul className="monitor-output-list" data-testid="monitor-results-artifacts">
                    {artifacts.map((artifact: Artifact) => (
                      <li key={artifact.id} data-testid={`monitor-artifact-${artifact.id}`}>
                        <span className="monitor-output-name">{artifact.name}</span>
                        <span className="muted">
                          {artifact.mediaType} · {formatBytes(artifact.size)}
                        </span>
                        <a
                          className="button button-sm button-outline"
                          href={artifactDownloadUrl(effectiveRun!.id, artifact.id)}
                          download={artifact.name}
                          data-testid={`monitor-artifact-download-${artifact.id}`}
                        >
                          Download
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="monitor-results-section">
                <h3 className="section-title">Metrics</h3>
                {metrics.length === 0 ? (
                  <p className="monitor-placeholder">No Metrics yet.</p>
                ) : (
                  <ul className="monitor-output-list" data-testid="monitor-results-metrics">
                    {metrics.map((metric: Metric) => (
                      <li key={metric.id} data-testid={`monitor-metric-${metric.id}`}>
                        <span className="monitor-output-name">{metric.name}</span>
                        <span className="muted">
                          {String(metric.value)}
                          {metric.unit ? ` ${metric.unit}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
            <button
              type="button"
              className="button button-outline"
              data-testid="open-result-view"
              disabled={!effectiveRun}
              onClick={() => effectiveRun && onOpenResultView?.(effectiveRun.id)}
            >
              Open Result View
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
