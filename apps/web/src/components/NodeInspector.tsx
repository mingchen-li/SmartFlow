import { useEffect, useState, type ReactNode } from 'react';
import {
  NodeResourcesSchema,
  validateParameters,
  type FileReference,
  type NodeManifest,
  type NodeResources,
  type ParameterSpec,
  type WorkflowNodeInstance,
} from '@sflow/domain';
import { useEditorStore } from '../store/editor';

export interface NodeInspectorProps {
  instance: WorkflowNodeInstance;
  manifest: NodeManifest;
  fileReferences: readonly FileReference[];
}

type InspectorTab = 'form' | 'raw';
type ResourceKey = keyof NodeResources;

interface RawConfiguration {
  parameters: Record<string, unknown>;
  resources: NodeResources;
}

interface RawValidation {
  errors: string[];
  config?: RawConfiguration;
}

function parseRawConfiguration(manifest: NodeManifest, text: string): RawValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { errors: [`Invalid JSON: ${message}`] };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { errors: ['Configuration must be a JSON object.'] };
  }

  const record = parsed as Record<string, unknown>;
  const parameters = record.parameters ?? {};
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return { errors: ['parameters must be an object.'] };
  }

  const resources = record.resources ?? {};
  const parsedResources = NodeResourcesSchema.safeParse(resources);
  if (!parsedResources.success) {
    return {
      errors: parsedResources.error.issues.map(
        (issue) => `resources.${issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }

  const issues = validateParameters(
    manifest,
    parameters as Record<string, unknown>,
  );
  if (issues.length > 0) {
    return { errors: issues.map((issue) => issue.message) };
  }

  return {
    errors: [],
    config: {
      parameters: parameters as Record<string, unknown>,
      resources: parsedResources.data,
    },
  };
}

function fileReferenceId(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { fileReferenceId?: unknown }).fileReferenceId === 'string'
  ) {
    return (value as { fileReferenceId: string }).fileReferenceId;
  }
  return '';
}

function ResourceField({
  id,
  label,
  placeholder,
  value,
  description,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  description?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={`resource-${id}`}>
        {label}
      </label>
      <input
        id={`resource-${id}`}
        className="input"
        type="text"
        inputMode={id === 'memory' || id === 'gpuType' ? 'text' : 'decimal'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`resource-${id}`}
      />
      {description ? <span className="field-hint">{description}</span> : null}
    </div>
  );
}

/**
 * Manifest-driven Node configuration. The Form tab is generated entirely from
 * the declared ParameterSpecs and resource requirements; the Raw tab validates
 * a JSON view with the same contracts before applying it.
 */
export function NodeInspector({ instance, manifest, fileReferences }: NodeInspectorProps) {
  const updateNodeParameters = useEditorStore((state) => state.updateNodeParameters);
  const updateNodeResources = useEditorStore((state) => state.updateNodeResources);

  const [tab, setTab] = useState<InspectorTab>('form');
  const [rawText, setRawText] = useState('');
  const [rawValidation, setRawValidation] = useState<RawValidation>({ errors: [] });

  useEffect(() => {
    setTab('form');
    setRawValidation({ errors: [] });
  }, [instance.id]);

  const parameterIssues = validateParameters(manifest, instance.parameters);
  const resourceValidation = NodeResourcesSchema.safeParse(instance.resources);

  function setParameter(id: string, value: unknown): void {
    const next = { ...instance.parameters };
    if (value === undefined) delete next[id];
    else next[id] = value;
    updateNodeParameters(instance.id, next);
  }

  function setResource(key: ResourceKey, value: NodeResources[ResourceKey] | undefined): void {
    const next: NodeResources = { ...instance.resources };
    if (value === undefined) delete next[key];
    else Object.assign(next, { [key]: value });
    updateNodeResources(instance.id, next);
  }

  function openRawTab(): void {
    setRawText(
      JSON.stringify(
        { parameters: instance.parameters, resources: instance.resources },
        null,
        2,
      ),
    );
    setRawValidation(parseRawConfiguration(manifest, JSON.stringify({
      parameters: instance.parameters,
      resources: instance.resources,
    })));
    setTab('raw');
  }

  function selectTab(nextTab: InspectorTab): void {
    if (nextTab === 'raw') {
      if (tab !== 'raw') openRawTab();
      return;
    }
    setTab('form');
  }

  function updateRaw(text: string): void {
    setRawText(text);
    setRawValidation(parseRawConfiguration(manifest, text));
  }

  function applyRaw(): void {
    if (!rawValidation.config) return;
    updateNodeParameters(instance.id, rawValidation.config.parameters);
    updateNodeResources(instance.id, rawValidation.config.resources);
    setTab('form');
  }

  const rawStatus = rawValidation.errors.length
    ? rawValidation.errors.join(' ')
    : 'Configuration is valid.';

  function renderParameterField(spec: ParameterSpec) {
    const value = instance.parameters[spec.id];
    const issue = parameterIssues.find((candidate) => candidate.path === spec.id);

    let control: ReactNode;
    switch (spec.type) {
      case 'string':
        control = (
          <input
            id={`param-${spec.id}`}
            className="input"
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) =>
              setParameter(spec.id, event.target.value === '' ? '' : event.target.value)
            }
            data-testid={`param-${spec.id}`}
            aria-invalid={issue ? true : undefined}
          />
        );
        break;
      case 'number':
        control = (
          <input
            id={`param-${spec.id}`}
            className="input"
            type="number"
            step={spec.integer ? 1 : 'any'}
            min={spec.min}
            max={spec.max}
            value={typeof value === 'number' ? value : ''}
            onChange={(event) => {
              const text = event.target.value;
              if (text === '') {
                setParameter(spec.id, undefined);
                return;
              }
              const parsed = Number(text);
              if (Number.isFinite(parsed)) setParameter(spec.id, parsed);
            }}
            data-testid={`param-${spec.id}`}
            aria-invalid={issue ? true : undefined}
          />
        );
        break;
      case 'boolean':
        control = (
          <label className="checkbox-field" htmlFor={`param-${spec.id}`}>
            <input
              id={`param-${spec.id}`}
              type="checkbox"
              checked={value === true}
              onChange={(event) => setParameter(spec.id, event.target.checked)}
              data-testid={`param-${spec.id}`}
            />
            <span>Enabled</span>
          </label>
        );
        break;
      case 'enum':
        control = (
          <select
            id={`param-${spec.id}`}
            className="input"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => setParameter(spec.id, event.target.value)}
            data-testid={`param-${spec.id}`}
            aria-invalid={issue ? true : undefined}
          >
            {!spec.required ? <option value="">Not set</option> : null}
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        );
        break;
      case 'file-reference': {
        const selectedId = fileReferenceId(value);
        control = (
          <>
            <select
              id={`param-${spec.id}`}
              className="input"
              value={selectedId}
              onChange={(event) => {
                const reference = fileReferences.find(
                  (candidate) => candidate.id === event.target.value,
                );
                if (!reference) {
                  setParameter(spec.id, undefined);
                  return;
                }
                setParameter(spec.id, {
                  fileReferenceId: reference.id,
                  path: reference.path,
                  name: reference.name,
                });
              }}
              data-testid={`param-${spec.id}`}
              aria-invalid={issue ? true : undefined}
            >
              <option value="">Select a Project file</option>
              {fileReferences.map((reference) => (
                <option key={reference.id} value={reference.id}>
                  {reference.path}
                </option>
              ))}
            </select>
            {fileReferences.length === 0 ? (
              <span className="field-hint">
                Select a file in the Project explorer to create a File Reference.
              </span>
            ) : null}
            {spec.accept?.length ? (
              <span className="field-hint">Accepted: {spec.accept.join(', ')}</span>
            ) : null}
          </>
        );
        break;
      }
    }

    return (
      <div className="field" key={spec.id}>
        <label className="label" htmlFor={`param-${spec.id}`}>
          {spec.name}
          {spec.required ? <span className="field-required"> *</span> : null}
        </label>
        {control}
        {spec.description ? <span className="field-hint">{spec.description}</span> : null}
        {issue ? (
          <span className="error-text" data-testid={`param-error-${spec.id}`}>
            {issue.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <section className="node-inspector" aria-label="Node configuration" data-testid="node-inspector">
      <header className="node-inspector-header">
        <div>
          <h3 className="node-inspector-title" data-testid="node-inspector-title">
            {instance.label}
          </h3>
          <span className="node-inspector-meta">
            {manifest.name} · {manifest.id}@{manifest.version}
          </span>
        </div>
        <span className="badge badge-info">{manifest.type}</span>
      </header>

      <div className="node-inspector-tabs" role="tablist" aria-label="Node configuration view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'form'}
          className="node-inspector-tab"
          data-testid="inspector-tab-form"
          onClick={() => selectTab('form')}
        >
          Form
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'raw'}
          className="node-inspector-tab"
          data-testid="inspector-tab-raw"
          onClick={() => selectTab('raw')}
        >
          Raw configuration
        </button>
      </div>

      <div className="node-inspector-body">
        {tab === 'form' ? (
          <form
            className="node-inspector-form"
            role="tabpanel"
            aria-label="Generated parameter form"
            onSubmit={(event) => event.preventDefault()}
          >
            <p
              className={`node-validation ${parameterIssues.length ? 'error-text' : 'success-text'}`}
              data-testid="inspector-validation"
            >
              {parameterIssues.length
                ? parameterIssues.map((issue) => issue.message).join(' ')
                : 'All parameters are valid.'}
            </p>

            {manifest.parameters.map(renderParameterField)}

            <h4 className="node-inspector-section-title">Resource overrides</h4>
            <p className="field-hint">
              Leave a field empty to inherit the Manifest requirement shown as its placeholder.
            </p>
            <ResourceField
              id="cpu"
              label="CPU"
              placeholder={String(manifest.resources.cpu ?? '')}
              value={instance.resources.cpu === undefined ? '' : String(instance.resources.cpu)}
              onChange={(text) =>
                setResource('cpu', text.trim() === '' ? undefined : Number(text))
              }
            />
            <ResourceField
              id="memory"
              label="Memory"
              placeholder={manifest.resources.memory ?? ''}
              value={instance.resources.memory ?? ''}
              onChange={(text) =>
                setResource('memory', text.trim() === '' ? undefined : text)
              }
            />
            <ResourceField
              id="gpu"
              label="GPU count"
              placeholder={
                manifest.resources.gpu === undefined ? '' : String(manifest.resources.gpu)
              }
              value={instance.resources.gpu === undefined ? '' : String(instance.resources.gpu)}
              onChange={(text) =>
                setResource('gpu', text.trim() === '' ? undefined : Number(text))
              }
            />
            <ResourceField
              id="gpuType"
              label="GPU type"
              placeholder={manifest.resources.gpuType ?? ''}
              value={instance.resources.gpuType ?? ''}
              onChange={(text) =>
                setResource('gpuType', text.trim() === '' ? undefined : text)
              }
            />
            <ResourceField
              id="walltime"
              label="Wall time (minutes)"
              placeholder={
                manifest.resources.walltimeMinutes === undefined
                  ? ''
                  : String(manifest.resources.walltimeMinutes)
              }
              value={
                instance.resources.walltimeMinutes === undefined
                  ? ''
                  : String(instance.resources.walltimeMinutes)
              }
              onChange={(text) =>
                setResource('walltimeMinutes', text.trim() === '' ? undefined : Number(text))
              }
            />

            {!resourceValidation.success ? (
              <p className="error-text" data-testid="resource-validation">
                {resourceValidation.error.issues
                  .map((issue) => issue.message)
                  .join(' ')}
              </p>
            ) : null}

            <h4 className="node-inspector-section-title">Declared ports</h4>
            <div className="node-meta-list" data-testid="inspector-ports">
              {manifest.inputs.map((port) => (
                <span key={`in-${port.id}`}>
                  In · {port.id} · {port.kind}
                  {port.dataType ? ` · ${port.dataType}` : ''}
                </span>
              ))}
              {manifest.outputs.map((port) => (
                <span key={`out-${port.id}`}>
                  Out · {port.id} · {port.kind}
                  {port.dataType ? ` · ${port.dataType}` : ''}
                </span>
              ))}
            </div>

            <h4 className="node-inspector-section-title">Declared Metrics</h4>
            <div className="node-meta-list" data-testid="inspector-metrics">
              {manifest.metrics.map((metric) => (
                <span key={metric.id}>
                  {metric.name}
                  {metric.unit ? ` (${metric.unit})` : ''}
                </span>
              ))}
            </div>

            <h4 className="node-inspector-section-title">Environment and retry</h4>
            <div className="node-meta-list" data-testid="inspector-environment">
              <span>{manifest.environment.image}</span>
              <span>
                Retry {manifest.retry.maxAttempts} time
                {manifest.retry.maxAttempts === 1 ? '' : 's'} after{' '}
                {manifest.retry.backoffSeconds}s
              </span>
            </div>
          </form>
        ) : (
          <div
            className="node-inspector-raw"
            role="tabpanel"
            aria-label="Raw Node configuration"
          >
            <label className="label" htmlFor="raw-config">
              Manifest-validated JSON
            </label>
            <textarea
              id="raw-config"
              className="textarea node-raw-textarea"
              value={rawText}
              onChange={(event) => updateRaw(event.target.value)}
              spellCheck={false}
              data-testid="raw-config"
            />
            <p
              className={`node-validation ${rawValidation.errors.length ? 'error-text' : 'success-text'}`}
              data-testid="raw-config-status"
              role="status"
            >
              {rawStatus}
            </p>
            <button
              type="button"
              className="button button-primary button-sm"
              disabled={!rawValidation.config}
              onClick={applyRaw}
              data-testid="apply-raw-config"
            >
              Apply configuration
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
