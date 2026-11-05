import type {
  ValidateWorkflowResponse,
  ValidationDiagnostic,
} from '@sflow/domain';
import { useEditorStore } from '../store/editor';

export interface WorkflowValidationPanelProps {
  validation: ValidateWorkflowResponse | null;
  validating: boolean;
  stale: boolean;
}

/**
 * Validation results shown beside the Workflow that produced them. Each
 * diagnostic names the affected Node or connection and states the correction;
 * the panel scrolls internally so the fixed-viewport shell never grows.
 */
export function WorkflowValidationPanel({
  validation,
  validating,
  stale,
}: WorkflowValidationPanelProps) {
  const nodes = useEditorStore((state) => state.workflow.nodes);
  const edges = useEditorStore((state) => state.workflow.edges);

  if (!validation && !validating) return null;

  const errors =
    validation?.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      .length ?? 0;
  const summary = validating
    ? 'Validating Workflow…'
    : validation
      ? validation.valid
        ? 'Workflow is valid.'
        : `${errors} validation error${errors === 1 ? '' : 's'}.`
      : '';

  function location(diagnostic: ValidationDiagnostic): string {
    // A diagnostic attached to a connection is reported by that connection;
    // Node-only diagnostics fall back to the affected Node.
    if (diagnostic.edgeId) {
      const edge = edges.find((candidate) => candidate.id === diagnostic.edgeId);
      if (edge) {
        const source = nodes.find((candidate) => candidate.id === edge.source);
        const target = nodes.find((candidate) => candidate.id === edge.target);
        return `Connection: ${source?.label ?? edge.source}.${edge.sourcePort} → ${target?.label ?? edge.target}.${edge.targetPort}`;
      }
      return `Connection: ${diagnostic.edgeId}`;
    }

    if (diagnostic.nodeId) {
      const node = nodes.find((candidate) => candidate.id === diagnostic.nodeId);
      return `Node: ${node?.label ?? diagnostic.nodeId}`;
    }

    return 'Workflow';
  }

  return (
    <section
      className="validation-panel"
      aria-label="Workflow validation"
      aria-live="polite"
      data-testid="validation-panel"
    >
      <div className="validation-panel-header">
        <span
          className={`badge ${
            validation?.valid && !stale
              ? 'badge-success'
              : errors > 0 || stale
                ? 'badge-warning'
                : 'badge-neutral'
          }`}
          data-testid="validation-summary"
        >
          {summary}
        </span>
        {stale ? (
          <span
            className="badge badge-warning"
            data-testid="validation-stale"
          >
            Draft changed — validate again
          </span>
        ) : null}
      </div>

      {validation && validation.diagnostics.length > 0 ? (
        <ul className="validation-list" data-testid="validation-diagnostics">
          {validation.diagnostics.map((diagnostic, index) => (
            <li
              key={`${diagnostic.code}-${diagnostic.nodeId ?? ''}-${diagnostic.edgeId ?? ''}-${diagnostic.path ?? ''}-${index}`}
              className="validation-diagnostic"
              data-testid="validation-diagnostic"
              data-code={diagnostic.code}
              data-severity={diagnostic.severity}
              data-node-id={diagnostic.nodeId ?? undefined}
              data-edge-id={diagnostic.edgeId ?? undefined}
            >
              <span className="validation-location" data-testid="validation-location">
                {location(diagnostic)}
              </span>
              <span className="validation-message">{diagnostic.message}</span>
              <span
                className="validation-correction"
                data-testid="validation-correction"
              >
                Correction: {diagnostic.correction}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
