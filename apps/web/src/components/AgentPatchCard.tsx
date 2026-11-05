import type { AgentPatch } from '@sflow/domain';

export interface AgentPatchCardProps {
  patch: AgentPatch;
  error?: string;
  busy: boolean;
  onApply: () => void;
  onReject: () => void;
  onRevert: () => void;
}

const STATUS_BADGE: Record<AgentPatch['status'], string> = {
  proposed: 'badge-info',
  applied: 'badge-success',
  rejected: 'badge-warning',
  reverted: 'badge-neutral',
};

function targetLabel(patch: AgentPatch): string {
  if (patch.target.kind === 'workflow') {
    return `Workflow ${patch.target.workflowId}${
      patch.target.nodeId ? ` · Node ${patch.target.nodeId}` : ''
    }`;
  }
  return `Result View ${patch.target.resultViewId}`;
}

/**
 * A typed Agent patch preview. It always shows what would change and the
 * validation result; Apply is available only for a proposed patch that passed
 * schema and semantic checks.
 */
export function AgentPatchCard({
  patch,
  error,
  busy,
  onApply,
  onReject,
  onRevert,
}: AgentPatchCardProps) {
  const diagnostics = patch.validation.diagnostics;
  const canApply = patch.status === 'proposed' && patch.validation.valid;

  return (
    <article
      className="agent-patch-card"
      data-testid="agent-patch-card"
      data-status={patch.status}
      data-valid={patch.validation.valid ? 'true' : 'false'}
      data-patch-id={patch.id}
      aria-label={`Agent patch: ${patch.summary}`}
    >
      <header className="agent-patch-card-header">
        <strong
          className="agent-patch-card-summary"
          data-testid="agent-patch-card-summary"
        >
          {patch.summary}
        </strong>
        <span className={`badge ${STATUS_BADGE[patch.status]}`} data-testid="agent-patch-status">
          {patch.status}
        </span>
      </header>

      <div className="agent-patch-meta">
        <span data-testid="agent-patch-scope">Scope: {patch.scope}</span>
        <span data-testid="agent-patch-target">{targetLabel(patch)}</span>
        <span data-testid="agent-patch-base-revision">
          Base revision {patch.baseRevision}
        </span>
        {patch.resultRevision !== null ? (
          <span data-testid="agent-patch-result-revision">
            Result revision {patch.resultRevision}
          </span>
        ) : null}
      </div>

      <p
        className={`agent-patch-validation ${patch.validation.valid ? 'success-text' : 'error-text'}`}
        data-testid="agent-patch-validation"
      >
        {patch.validation.valid
          ? 'Schema and semantic validation passed'
          : `Rejected: ${diagnostics.length} validation diagnostic${
              diagnostics.length === 1 ? '' : 's'
            }`}
      </p>

      {diagnostics.length > 0 ? (
        <ul className="agent-patch-diagnostics" data-testid="agent-patch-diagnostics">
          {diagnostics.map((diagnostic, index) => (
            <li
              key={`${diagnostic.code}-${diagnostic.path ?? ''}-${index}`}
              className="agent-patch-diagnostic"
              data-testid="agent-patch-diagnostic"
              data-code={diagnostic.code}
              data-severity={diagnostic.severity}
            >
              <span className="agent-patch-diagnostic-path">
                {diagnostic.path || diagnostic.nodeId || 'Workflow'}
              </span>
              <span>{diagnostic.message}</span>
              <span className="muted">{diagnostic.correction}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="agent-patch-diff" data-testid="agent-patch-diff">
        {patch.diff.map((entry) => (
          <li
            key={`${entry.operation}-${entry.path}`}
            className="agent-patch-diff-entry"
            data-testid="agent-patch-diff-entry"
            data-op={entry.op}
            data-path={entry.path}
          >
            <span className="agent-patch-op">{entry.op}</span>
            <span>{entry.description}</span>
          </li>
        ))}
      </ul>

      <details className="agent-patch-raw" open>
        <summary>Raw operations</summary>
        <pre data-testid="agent-patch-operations-raw">
          {JSON.stringify(patch.operations, null, 2)}
        </pre>
      </details>

      {error ? (
        <p className="error-text" role="alert" data-testid="agent-patch-conflict">
          {error}
        </p>
      ) : null}

      <div className="agent-patch-actions">
        {patch.status === 'proposed' || patch.status === 'rejected' ? (
          <button
            type="button"
            className="button button-sm button-primary"
            disabled={!canApply || busy}
            aria-busy={busy}
            onClick={onApply}
            data-testid="agent-patch-apply"
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        ) : null}
        {patch.status === 'proposed' ? (
          <button
            type="button"
            className="button button-sm button-outline"
            disabled={busy}
            onClick={onReject}
            data-testid="agent-patch-reject"
          >
            Reject
          </button>
        ) : null}
        {patch.status === 'applied' ? (
          <button
            type="button"
            className="button button-sm button-outline"
            disabled={busy}
            onClick={onRevert}
            data-testid="agent-patch-revert"
          >
            {busy ? 'Reverting…' : 'Revert'}
          </button>
        ) : null}
      </div>
    </article>
  );
}
