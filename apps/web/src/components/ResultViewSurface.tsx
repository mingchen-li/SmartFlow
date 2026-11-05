import { useEffect, useMemo, useState } from 'react';
import {
  CANDIDATE_SET_SCHEMA_REF,
  CandidateSetSchema,
  ResultViewDataSchema,
  ResultViewIRSchema,
  WidgetDescriptorSchema,
  isActiveRunStatus,
  schemaKey,
  validateResultViewBindings,
  type Artifact,
  type CandidateSet,
  type Metric,
  type ResultViewBlock,
  type ResultViewBlockEvaluation,
  type ResultViewCompatibilityReport,
  type ResultViewData,
  type ResultViewIR,
  type ResultViewResponse,
  type RunEvent,
  type Task,
  type WidgetDescriptor,
} from '@sflow/domain';
import { artifactDownloadUrl, getResultView, getRunEvents } from '../api';
import { useTaskLogs } from '../hooks/useTaskLogs';

export interface ResultViewSurfaceProps {
  runId: string;
  onClose: () => void;
}

interface ResolvedView {
  ir: ResultViewIR;
  data: ResultViewData;
  widgets: WidgetDescriptor[];
  compatibility: ResultViewCompatibilityReport;
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const time = value.includes('T') ? value.split('T')[1] ?? value : value;
  return time.replace(/Z$/, '').slice(0, 8);
}

function eventLine(event: RunEvent): string {
  const payload =
    event.payload === undefined ? '' : ` ${JSON.stringify(event.payload)}`;
  return `#${event.id} ${formatTime(event.createdAt)} ${event.type}${
    event.taskId ? ` task=${event.taskId}` : ''
  }${payload}`;
}

function schemaLabel(schema: { namespace: string; name: string; version: string } | undefined): string {
  return schema ? schemaKey(schema) : 'no schema';
}

function knownSchema(schema: { namespace: string; name: string; version: string } | undefined): boolean {
  if (!schema) return false;
  return ['candidate-set', 'comparison-report', 'target-structure', 'predicted-structure'].includes(
    schema.name,
  );
}

function statusTone(status: string): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-warning';
  if (status === 'queued' || status === 'running') return 'badge-info';
  return 'badge-neutral';
}

function DownloadLink({
  runId,
  artifact,
  testIdPrefix,
}: {
  runId: string;
  artifact: Artifact;
  testIdPrefix: string;
}) {
  return (
    <a
      className="button button-sm button-outline"
      href={artifactDownloadUrl(runId, artifact.id)}
      download={artifact.name}
      data-testid={`${testIdPrefix}${artifact.id}`}
    >
      Download
    </a>
  );
}

function ArtifactRow({
  runId,
  artifact,
}: {
  runId: string;
  artifact: Artifact;
}) {
  const generic = !knownSchema(artifact.schema);
  return (
    <article
      className={`result-artifact${generic ? ' result-artifact-generic' : ''}`}
      data-testid={generic ? `generic-output-${artifact.id}` : `result-artifact-${artifact.id}`}
      data-generic={generic ? 'true' : 'false'}
      data-schema={artifact.schema ? schemaKey(artifact.schema) : 'none'}
    >
      <div className="result-artifact-main">
        <span className="result-artifact-name">{artifact.name}</span>
        <span className="muted">
          {artifact.mediaType} · {artifact.size} bytes ·{' '}
          {artifact.schema ? schemaKey(artifact.schema) : 'Unknown output (no schema)'}
        </span>
      </div>
      <DownloadLink runId={runId} artifact={artifact} testIdPrefix="artifact-download-" />
      <details className="result-metadata" data-testid={`artifact-metadata-${artifact.id}`}>
        <summary>Raw metadata</summary>
        <pre>{JSON.stringify(artifact, null, 2)}</pre>
      </details>
    </article>
  );
}

function CandidateSetSection({
  artifact,
  data,
}: {
  artifact: Artifact;
  data: CandidateSet;
}) {
  return (
    <section
      className="result-candidate-set"
      data-testid={`candidate-set-${artifact.id}`}
      data-schema={schemaLabel(artifact.schema)}
    >
      <h3 className="section-title">
        {data.name} <span className="muted">({artifact.name})</span>
      </h3>
      <p className="muted">
        {data.candidates.length} candidates · strategy {data.context.strategy}
        {data.context.label ? ` · ${data.context.label}` : ''}
      </p>
      <div className="result-scroll">
        <table className="result-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Sequence</th>
              <th>Generation</th>
              <th>Scores</th>
            </tr>
          </thead>
          <tbody>
            {data.candidates.map((candidate) => {
              const scores = data.scores
                .filter((score) => score.candidateId === candidate.id)
                .map((score) => `${score.metricId}=${score.value}`)
                .join(', ');
              return (
                <tr
                  key={candidate.id}
                  data-testid={`candidate-row-${artifact.id}-${candidate.id}`}
                >
                  <td>{candidate.id}</td>
                  <td className="result-sequence" title={candidate.sequence}>
                    {candidate.sequence}
                  </td>
                  <td>{candidate.generation ?? '—'}</td>
                  <td>{scores || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MetricTable({
  metrics,
  tasksById,
}: {
  metrics: Metric[];
  tasksById: Map<string, Task>;
}) {
  const groups = new Map<string, Metric[]>();
  for (const metric of metrics) {
    const key = schemaKey(metric.schema);
    groups.set(key, [...(groups.get(key) ?? []), metric]);
  }

  return (
    <div className="result-metric-groups">
      {[...groups.entries()].map(([key, group]) => (
        <section key={key} className="result-metric-group" data-testid={`metric-group-${key}`}>
          <h3 className="section-title">{key}</h3>
          <div className="result-scroll">
            <table className="result-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                  <th>Unit</th>
                  <th>Meaning</th>
                  <th>Task</th>
                </tr>
              </thead>
              <tbody>
                {group.map((metric) => (
                  <tr key={metric.id} data-testid={`metric-${metric.id}`}>
                    <td>{metric.name}</td>
                    <td>
                      {String(metric.value)} <span className="muted">{metric.valueType}</span>
                    </td>
                    <td>{metric.unit ?? '—'}</td>
                    <td className="result-meaning">{metric.meaning}</td>
                    <td>{tasksById.get(metric.taskId)?.label ?? metric.taskId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function ProvenanceList({
  artifacts,
  tasksById,
}: {
  artifacts: Artifact[];
  tasksById: Map<string, Task>;
}) {
  return (
    <ul className="result-provenance" data-testid="result-provenance-list">
      {artifacts.map((artifact) => (
        <li key={artifact.id} data-testid={`provenance-${artifact.id}`}>
          <details>
            <summary>
              <strong>{artifact.name}</strong>{' '}
              <span className="muted">
                {artifact.provenance.manifestId}@{artifact.provenance.manifestVersion} ·{' '}
                {tasksById.get(artifact.provenance.taskId)?.label ?? artifact.provenance.taskId} ·
                attempt {artifact.provenance.attempt} · {artifact.provenance.executor.kind}{' '}
                {artifact.provenance.executor.jobId}
              </span>
            </summary>
            <dl className="reference-grid">
              <dt>Node</dt>
              <dd>{artifact.provenance.nodeId}</dd>
              <dt>Task</dt>
              <dd>{artifact.provenance.taskId}</dd>
              <dt>Input Artifacts</dt>
              <dd>{artifact.provenance.inputs.artifacts.join(', ') || 'None'}</dd>
              <dt>File References</dt>
              <dd>
                {artifact.provenance.inputs.fileReferences
                  .map((reference) => reference.path)
                  .join(', ') || 'None'}
              </dd>
              <dt>Environment</dt>
              <dd>
                {artifact.provenance.environment.kind}{' '}
                {artifact.provenance.environment.image ?? ''}
              </dd>
              <dt>Parameters</dt>
              <dd>
                <code>{JSON.stringify(artifact.provenance.parameters)}</code>
              </dd>
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function ResultViewSurface({ runId, onClose }: ResultViewSurfaceProps) {
  const [response, setResponse] = useState<ResultViewResponse | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [candidateSets, setCandidateSets] = useState<Record<string, CandidateSet>>({});

  const tasks = response?.data.tasks;
  const taskLogs = useTaskLogs(runId, tasks);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load(): Promise<void> {
      try {
        const [resultView, eventsResponse] = await Promise.all([
          getResultView(runId),
          getRunEvents(runId),
        ]);
        if (cancelled) return;
        setResponse(resultView);
        setEvents(eventsResponse.events);
        setError(null);
        if (isActiveRunStatus(resultView.data.run.status)) {
          timer = window.setTimeout(() => void load(), 700);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : 'The Result View could not be loaded.',
        );
        timer = window.setTimeout(() => void load(), 1_000);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /**
   * The Client re-runs the same shared schema-compatibility validation the
   * Server uses. A Widget binding is therefore rejected before rendering even
   * if a response claims otherwise, and rejected blocks never carry data.
   */
  const resolved = useMemo<ResolvedView | null>(() => {
    if (!response) return null;
    const ir = ResultViewIRSchema.safeParse(response.resultView);
    const data = ResultViewDataSchema.safeParse(response.data);
    if (!ir.success || !data.success) return null;

    const widgets = response.widgets.flatMap((candidate) => {
      const parsed = WidgetDescriptorSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });

    return {
      ir: ir.data,
      data: data.data,
      widgets,
      compatibility: validateResultViewBindings(ir.data, data.data, widgets),
    };
  }, [response]);

  const evaluations = useMemo(() => {
    const map = new Map<string, ResultViewBlockEvaluation>();
    for (const evaluation of resolved?.compatibility.blocks ?? []) {
      map.set(evaluation.blockId, evaluation);
    }
    return map;
  }, [resolved]);

  const artifactsById = useMemo(
    () => new Map((resolved?.data.artifacts ?? []).map((artifact) => [artifact.id, artifact])),
    [resolved],
  );
  const metricsById = useMemo(
    () => new Map((resolved?.data.metrics ?? []).map((metric) => [metric.id, metric])),
    [resolved],
  );
  const tasksById = useMemo(
    () => new Map((resolved?.data.tasks ?? []).map((task) => [task.id, task])),
    [resolved],
  );

  // CandidateSets come from compatible schema-bound Artifact bindings only.
  const candidateArtifactIds = useMemo(() => {
    if (!resolved) return [] as string[];
    const ids = new Set<string>();
    for (const evaluation of resolved.compatibility.blocks) {
      if (evaluation.status !== 'compatible') continue;
      for (const id of evaluation.artifactIds) {
        const artifact = artifactsById.get(id);
        if (
          artifact?.schema?.name === CANDIDATE_SET_SCHEMA_REF.name &&
          artifact.schema.namespace === CANDIDATE_SET_SCHEMA_REF.namespace &&
          artifact.schema.version === CANDIDATE_SET_SCHEMA_REF.version &&
          artifact.mediaType.includes('json')
        ) {
          ids.add(id);
        }
      }
    }
    return [...ids];
  }, [artifactsById, resolved]);
  const candidateArtifactSignature = candidateArtifactIds.join('|');

  useEffect(() => {
    let cancelled = false;
    for (const artifactId of candidateArtifactIds) {
      if (candidateSets[artifactId]) continue;
      void fetch(artifactDownloadUrl(runId, artifactId), {
        credentials: 'same-origin',
      })
        .then(async (result) => (result.ok ? ((await result.json()) as unknown) : undefined))
        .then((value) => {
          if (cancelled || value === undefined) return;
          const parsed = CandidateSetSchema.safeParse(value);
          if (!parsed.success) return;
          setCandidateSets((current) => ({ ...current, [artifactId]: parsed.data }));
        })
        .catch(() => {
          // A non-decodable CandidateSet stays a generic Artifact.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateArtifactSignature, runId]);

  if (error && !resolved) {
    return (
      <div className="result-view-overlay" data-testid="result-view-surface">
        <section
          className="result-view-surface"
          role="dialog"
          aria-modal="true"
          aria-label="Result View"
        >
          <header className="result-view-header">
            <h1>Result View</h1>
            <button
              type="button"
              className="button button-ghost"
              data-testid="result-view-close"
              onClick={onClose}
            >
              Close
            </button>
          </header>
          <p className="result-view-error" data-testid="result-view-error" role="alert">
            {error}
          </p>
        </section>
      </div>
    );
  }

  if (!resolved) {
    return (
      <div className="result-view-overlay" data-testid="result-view-surface">
        <section
          className="result-view-surface"
          role="dialog"
          aria-modal="true"
          aria-label="Result View"
        >
          <header className="result-view-header">
            <h1>Result View</h1>
            <button
              type="button"
              className="button button-ghost"
              data-testid="result-view-close"
              onClick={onClose}
            >
              Close
            </button>
          </header>
          <p className="result-view-loading" data-testid="result-view-loading">
            Loading Result View…
          </p>
        </section>
      </div>
    );
  }

  const { ir, data, widgets } = resolved;
  const active = isActiveRunStatus(data.run.status);

  function renderBlock(block: ResultViewBlock, evaluation: ResultViewBlockEvaluation) {
    const blockTestId = `result-view-block-${block.id}`;
    const empty = evaluation.status === 'empty';
    const artifacts = evaluation.artifactIds.flatMap((id) => {
      const artifact = artifactsById.get(id);
      return artifact ? [artifact] : [];
    });
    const metrics = evaluation.metricIds.flatMap((id) => {
      const metric = metricsById.get(id);
      return metric ? [metric] : [];
    });
    const logTasks = evaluation.taskIds.flatMap((id) => {
      const task = tasksById.get(id);
      return task ? [task] : [];
    });

    if (block.kind === 'logs') {
      return (
        <section key={block.id} className="result-block" data-testid={blockTestId}>
          <h2 className="result-block-title">{block.title}</h2>
          {empty ? (
            <p className="muted">No logs available for this Run.</p>
          ) : (
            <div className="result-log-grid">
              <section className="result-log-section">
                <h3 className="section-title">Run events</h3>
                <pre className="result-log-pane" data-testid="result-view-events-log">
                  {events.length === 0 ? 'No Run events yet.' : events.map(eventLine).join('\n')}
                </pre>
              </section>
              {logTasks.map((task) => (
                <section className="result-log-section" key={task.id}>
                  <h3 className="section-title">
                    {task.label} <span className="muted">attempt {task.attempt}</span>
                  </h3>
                  <pre
                    className="result-log-pane"
                    data-testid={`result-view-task-log-${task.id}`}
                  >
                    {task.logsAvailable
                      ? (taskLogs[task.id]?.lines.join('\n') ?? 'Loading Task logs…')
                      : 'No log file available.'}
                  </pre>
                </section>
              ))}
            </div>
          )}
        </section>
      );
    }

    if (block.kind === 'artifacts') {
      return (
        <section key={block.id} className="result-block" data-testid={blockTestId}>
          <h2 className="result-block-title">{block.title}</h2>
          {artifacts.length === 0 ? (
            <p className="muted">No output files recorded yet.</p>
          ) : (
            <div className="result-artifacts">
              {artifacts.map((artifact) => (
                <ArtifactRow key={artifact.id} runId={runId} artifact={artifact} />
              ))}
            </div>
          )}
        </section>
      );
    }

    if (block.kind === 'candidates') {
      return (
        <section key={block.id} className="result-block" data-testid={blockTestId}>
          <h2 className="result-block-title">{block.title}</h2>
          {empty ? (
            <p className="muted">No compatible CandidateSets were produced.</p>
          ) : (
            <div className="result-candidate-sets">
              {artifacts.map((artifact) => {
                const candidateSet = candidateSets[artifact.id];
                return candidateSet ? (
                  <CandidateSetSection
                    key={artifact.id}
                    artifact={artifact}
                    data={candidateSet}
                  />
                ) : (
                  <p className="muted" key={artifact.id} data-testid={`candidate-pending-${artifact.id}`}>
                    {artifact.name}: {artifact.mediaType.includes('json')
                      ? 'loading CandidateSet…'
                      : 'sequence file (download available above)'}
                  </p>
                );
              })}
            </div>
          )}
        </section>
      );
    }

    if (block.kind === 'metrics') {
      return (
        <section key={block.id} className="result-block" data-testid={blockTestId}>
          <h2 className="result-block-title">{block.title}</h2>
          {empty ? (
            <p className="muted">No Metrics recorded yet.</p>
          ) : (
            <MetricTable metrics={metrics} tasksById={tasksById} />
          )}
        </section>
      );
    }

    if (block.kind === 'provenance') {
      return (
        <section key={block.id} className="result-block" data-testid={blockTestId}>
          <h2 className="result-block-title">{block.title}</h2>
          {empty ? (
            <p className="muted">No Provenance was recorded.</p>
          ) : (
            <ProvenanceList artifacts={artifacts} tasksById={tasksById} />
          )}
        </section>
      );
    }

    // Widget blocks render only through registered descriptors and only with
    // data resolved by schema. Unknown Widgets are rejected by validation and
    // omitted with a reason; they never fall through to arbitrary rendering.
    const widget = widgets.find((candidate) => candidate.id === block.widgetId);
    if (!widget) return null;
    const widgetTestId = `result-view-widget-${widget.id}`;
    const candidateArtifacts = artifacts.filter(
      (artifact) => candidateSets[artifact.id] !== undefined,
    );
    const structureArtifacts = artifacts;

    return (
      <section
        key={block.id}
        className="result-block result-widget"
        data-testid={blockTestId}
        data-widget-id={widget.id}
      >
        <h2 className="result-block-title">
          {block.title} <span className="muted">{widget.id}@{widget.version}</span>
        </h2>
        <p className="muted result-widget-description">{widget.description}</p>
        <div data-testid={widgetTestId}>
          {empty ? (
            <p className="muted" data-testid={`widget-empty-${widget.id}`}>
              No compatible data for this Widget.
            </p>
          ) : widget.id === 'sflow.candidate-table' ? (
            candidateArtifacts.length === 0 ? (
              <p className="muted">
                No compatible CandidateSet data for this Widget.
              </p>
            ) : (
              candidateArtifacts.map((artifact) => (
                <CandidateSetSection
                  key={artifact.id}
                  artifact={artifact}
                  data={candidateSets[artifact.id]!}
                />
              ))
            )
          ) : widget.id === 'sflow.metric-summary' ? (
            <div className="result-metric-grid">
              {metrics.map((metric) => (
                <article
                  className="result-metric-card"
                  key={metric.id}
                  data-testid={`widget-metric-${metric.id}`}
                >
                  <span className="muted">{schemaKey(metric.schema)}</span>
                  <div className="result-metric-value">
                    {String(metric.value)}
                    {metric.unit ? ` ${metric.unit}` : ''}
                  </div>
                  <span>{metric.name}</span>
                  <span className="muted">{metric.meaning}</span>
                </article>
              ))}
            </div>
          ) : widget.id === 'sflow.structure-viewer' ? (
            <ul className="result-widget-artifacts">
              {structureArtifacts.map((artifact) => (
                <li key={artifact.id} data-testid={`structure-artifact-${artifact.id}`}>
                  <span>{artifact.name}</span>
                  <span className="muted">{schemaKey(artifact.schema!)}</span>
                  <DownloadLink
                    runId={runId}
                    artifact={artifact}
                    testIdPrefix="structure-download-"
                  />
                </li>
              ))}
            </ul>
          ) : (
            // A registered Widget without a specialized renderer still gets a
            // safe descriptor-driven surface, never arbitrary code.
            <div className="result-widget-generic">
              <p className="muted">
                Accepted Artifact schemas:{' '}
                {widget.acceptedArtifactSchemas.map(schemaKey).join(', ') || 'none'}
              </p>
              <p className="muted">
                Accepted Metric schemas:{' '}
                {widget.acceptedMetricSchemas.map(schemaKey).join(', ') || 'none'}
              </p>
              <ul>
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    {artifact.name} <span className="muted">{artifact.mediaType}</span>{' '}
                    <DownloadLink
                      runId={runId}
                      artifact={artifact}
                      testIdPrefix="widget-download-"
                    />
                  </li>
                ))}
                {metrics.map((metric) => (
                  <li key={metric.id}>
                    {metric.name}: {String(metric.value)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    );
  }

  const rejected = ir.blocks.flatMap((block) => {
    const evaluation = evaluations.get(block.id);
    return evaluation?.status === 'rejected' ? [{ block, evaluation }] : [];
  });

  return (
    <div
      className="result-view-overlay"
      data-testid="result-view-surface"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="result-view-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Result View"
      >
        <header className="result-view-header">
          <div className="result-view-heading">
            <h1>Result View</h1>
            <span className="muted" data-testid="result-view-run-id">
              Run {ir.runId} · Result View {ir.version}
            </span>
          </div>
          <div className="result-view-header-meta">
            {active ? <span className="monitor-live">Live</span> : null}
            <span
              className={`badge ${statusTone(data.run.status)}`}
              data-testid="result-view-run-status"
            >
              {data.run.status}
            </span>
            <button
              type="button"
              className="button button-ghost"
              data-testid="result-view-close"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>

        <div className="result-view-body">
          {rejected.length > 0 ? (
            <section className="result-rejections" aria-label="Omitted blocks">
              <h2 className="result-block-title">Omitted blocks</h2>
              {rejected.map(({ block, evaluation }) => (
                <p
                  key={block.id}
                  className="result-rejection"
                  data-testid={`result-view-rejection-${block.id}`}
                >
                  <strong>{block.title}</strong> was omitted: {evaluation.reason}
                </p>
              ))}
            </section>
          ) : null}

          {ir.blocks.map((block) => {
            const evaluation = evaluations.get(block.id);
            if (!evaluation || evaluation.status === 'rejected') return null;
            return renderBlock(block, evaluation);
          })}
        </div>
      </section>
    </div>
  );
}
