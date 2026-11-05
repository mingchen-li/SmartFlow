import { z } from 'zod';

/**
 * Workflow execution contracts (ticket #5).
 *
 * Workflow IR is the canonical execution protocol. Canvas positions, viewport,
 * selection, panel geometry, maximize mode, Node Library search, and other
 * runtime UI state live in `EditorLayout` or in the Web app, never in the IR.
 * Every object schema here is strict so a layout-shaped field cannot leak into
 * persisted execution semantics.
 */

export const WorkflowPortKindSchema = z.enum(['data', 'control']);
export type WorkflowPortKind = z.infer<typeof WorkflowPortKindSchema>;

export const PortDirectionSchema = z.enum(['input', 'output']);
export type PortDirection = z.infer<typeof PortDirectionSchema>;

/**
 * A declared connection point. Data ports carry a namespaced `dataType`;
 * control ports carry execution ordering without a payload.
 */
export const NodePortSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    direction: PortDirectionSchema,
    kind: WorkflowPortKindSchema,
    dataType: z.string().min(1).max(200).optional(),
    required: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
  })
  .superRefine((port, context) => {
    if (port.kind === 'data' && !port.dataType) {
      context.addIssue({
        code: 'custom',
        path: ['dataType'],
        message: 'Data ports must declare a dataType.',
      });
    }
    if (port.kind === 'control' && port.dataType) {
      context.addIssue({
        code: 'custom',
        path: ['dataType'],
        message: 'Control ports must not declare a dataType.',
      });
    }
  });
export type NodePort = z.infer<typeof NodePortSchema>;

const MEMORY_PATTERN = /^\d+(?:\.\d+)?\s?(?:Ki|Mi|Gi|Ti|K|M|G|T|B|KB|MB|GB|TB)$/i;

/**
 * Declared resource requirements and per-instance overrides. Fields are
 * optional so a Node instance can override only what it needs; the Manifest
 * supplies the defaults a Run snapshot records.
 */
export const NodeResourcesSchema = z.strictObject({
  cpu: z.number().positive().optional(),
  memory: z.string().regex(MEMORY_PATTERN, 'Use a size such as 8Gi.').optional(),
  gpu: z.number().int().nonnegative().optional(),
  gpuType: z.string().min(1).max(200).optional(),
  walltimeMinutes: z.number().int().positive().optional(),
});
export type NodeResources = z.infer<typeof NodeResourcesSchema>;

/**
 * A path-backed Project File Reference selected for a file parameter. The
 * reference carries the Project filesystem path, never copied bytes or a
 * content digest (ADR-0008).
 */
export const FileReferenceParameterValueSchema = z.strictObject({
  fileReferenceId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type FileReferenceParameterValue = z.infer<typeof FileReferenceParameterValueSchema>;

const parameterBase = {
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  required: z.boolean().optional(),
};

/**
 * Parameter specifications drive both generated forms and validation.
 * Common scientific parameter types are first-class so the UI never needs a
 * Node-specific form implementation.
 */
export const ParameterSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...parameterBase,
    type: z.literal('string'),
    default: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('number'),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('enum'),
    options: z
      .array(
        z.strictObject({
          value: z.string().min(1),
          label: z.string().min(1).optional(),
          description: z.string().max(2_000).optional(),
        }),
      )
      .min(1),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('file-reference'),
    accept: z.array(z.string().min(1)).optional(),
    default: FileReferenceParameterValueSchema.optional(),
  }),
]);
export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;

export const MetricSpecSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  valueType: z.enum(['number', 'string', 'boolean']),
  unit: z.string().min(1).max(200).optional(),
  direction: z.enum(['higher-is-better', 'lower-is-better', 'neutral']).optional(),
});
export type MetricSpec = z.infer<typeof MetricSpecSchema>;

export const NodeEnvironmentSchema = z.strictObject({
  kind: z.enum(['container', 'host']),
  image: z.string().min(1),
  command: z.array(z.string().min(1)).optional(),
  variables: z.record(z.string(), z.string()).optional(),
});
export type NodeEnvironment = z.infer<typeof NodeEnvironmentSchema>;

export const RetryPolicySchema = z.strictObject({
  maxAttempts: z.number().int().min(1),
  backoffSeconds: z.number().nonnegative(),
  retryOn: z.array(z.enum(['transient', 'timeout', 'exit-code'])),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * A Node Manifest declares a Node's ports, generated-form parameter schema,
 * scientific Metrics, resource requirements, environment contract, and retry
 * policy. It contains no model execution logic.
 */
export const NodeManifestSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000),
    category: z.string().min(1).max(200),
    type: z.string().min(1).max(200),
    inputs: z.array(NodePortSchema),
    outputs: z.array(NodePortSchema),
    parameters: z.array(ParameterSpecSchema),
    metrics: z.array(MetricSpecSchema),
    resources: NodeResourcesSchema,
    environment: NodeEnvironmentSchema,
    retry: RetryPolicySchema,
  })
  .superRefine((manifest, context) => {
    const portIds = new Set<string>();
    for (const [collection, expectedDirection] of [
      ['inputs', 'input'],
      ['outputs', 'output'],
    ] as const) {
      manifest[collection].forEach((port, index) => {
        if (port.direction !== expectedDirection) {
          context.addIssue({
            code: 'custom',
            path: [collection, index, 'direction'],
            message: `Ports in ${collection} must use direction "${expectedDirection}".`,
          });
        }
        if (portIds.has(port.id)) {
          context.addIssue({
            code: 'custom',
            path: [collection, index, 'id'],
            message: `Duplicate port id "${port.id}".`,
          });
        }
        portIds.add(port.id);
      });
    }

    const parameterIds = new Set<string>();
    manifest.parameters.forEach((parameter, index) => {
      if (parameterIds.has(parameter.id)) {
        context.addIssue({
          code: 'custom',
          path: ['parameters', index, 'id'],
          message: `Duplicate parameter id "${parameter.id}".`,
        });
      }
      parameterIds.add(parameter.id);
    });
  });
export type NodeManifest = z.infer<typeof NodeManifestSchema>;

/**
 * A Node instance references a Manifest id and exact version, and carries only
 * user configuration. It never stores a React Flow node, a canvas position, or
 * render state.
 */
export const WorkflowNodeInstanceSchema = z.strictObject({
  id: z.string().min(1).max(200),
  manifestId: z.string().min(1).max(200),
  manifestVersion: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  parameters: z.record(z.string(), z.unknown()).default({}),
  resources: NodeResourcesSchema.default({}),
});
export type WorkflowNodeInstance = z.infer<typeof WorkflowNodeInstanceSchema>;

export const WorkflowEdgeSchema = z.strictObject({
  id: z.string().min(1).max(300),
  source: z.string().min(1).max(200),
  sourcePort: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  targetPort: z.string().min(1).max(200),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowIRSchema = z.strictObject({
  version: z.number().int().positive(),
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  nodes: z.array(WorkflowNodeInstanceSchema),
  edges: z.array(WorkflowEdgeSchema),
});
export type WorkflowIR = z.infer<typeof WorkflowIRSchema>;

/**
 * Editor layout is persisted beside the draft so a reload restores the editing
 * context. It is deliberately excluded from Workflow IR and Run snapshots.
 */
export const CanvasPositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});
export type CanvasPosition = z.infer<typeof CanvasPositionSchema>;

export const CanvasViewportSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});
export type CanvasViewport = z.infer<typeof CanvasViewportSchema>;

export const EditorSelectionSchema = z.strictObject({
  nodeId: z.string().min(1).nullable(),
  edgeId: z.string().min(1).nullable(),
});
export type EditorSelection = z.infer<typeof EditorSelectionSchema>;

export const EditorLayoutSchema = z.strictObject({
  version: z.number().int().positive(),
  positions: z.record(z.string(), CanvasPositionSchema),
  viewport: CanvasViewportSchema,
  selection: EditorSelectionSchema,
});
export type EditorLayout = z.infer<typeof EditorLayoutSchema>;

export const NodeCatalogResponseSchema = z.object({
  nodes: z.array(NodeManifestSchema),
});
export type NodeCatalogResponse = z.infer<typeof NodeCatalogResponseSchema>;

export const NodeManifestParamsSchema = z.object({
  id: z.string().min(1).max(200),
});
export type NodeManifestParams = z.infer<typeof NodeManifestParamsSchema>;

export const DEFAULT_CANVAS_ZOOM = 0.86;

export function createEmptyWorkflow(): WorkflowIR {
  return { version: 1, nodes: [], edges: [] };
}

export function createEmptyEditorLayout(): EditorLayout {
  return {
    version: 1,
    positions: {},
    viewport: { x: 0, y: 0, zoom: DEFAULT_CANVAS_ZOOM },
    selection: { nodeId: null, edgeId: null },
  };
}

export function findManifest(
  manifests: readonly NodeManifest[],
  id: string,
  version?: string,
): NodeManifest | undefined {
  return manifests.find(
    (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
  );
}

/**
 * Produces the configuration an inserted Node instance starts with: every
 * declared default, and no value for parameters that require an explicit
 * choice (for example a path-backed File Reference).
 */
export function defaultParameters(manifest: NodeManifest): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const spec of manifest.parameters) {
    if (!('default' in spec) || spec.default === undefined) continue;
    parameters[spec.id] =
      typeof spec.default === 'object' && spec.default !== null
        ? { ...spec.default }
        : spec.default;
  }
  return parameters;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Validates a Node instance's parameters against its Manifest. The same
 * function powers generated-form inline errors and the raw configuration view.
 */
export function validateParameters(
  manifest: NodeManifest,
  parameters: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const specs = new Map(manifest.parameters.map((spec) => [spec.id, spec]));

  for (const spec of manifest.parameters) {
    const value = parameters[spec.id];

    if (isMissing(value)) {
      if (spec.required) {
        issues.push({ path: spec.id, message: `${spec.name} is required.` });
      }
      continue;
    }

    switch (spec.type) {
      case 'string': {
        if (typeof value !== 'string') {
          issues.push({ path: spec.id, message: `${spec.name} must be text.` });
          break;
        }
        if (spec.minLength !== undefined && value.length < spec.minLength) {
          issues.push({
            path: spec.id,
            message: `${spec.name} must be at least ${spec.minLength} characters.`,
          });
        }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) {
          issues.push({
            path: spec.id,
            message: `${spec.name} must be at most ${spec.maxLength} characters.`,
          });
        }
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ path: spec.id, message: `${spec.name} must be a number.` });
          break;
        }
        if (spec.integer && !Number.isInteger(value)) {
          issues.push({ path: spec.id, message: `${spec.name} must be an integer.` });
        }
        if (spec.min !== undefined && value < spec.min) {
          issues.push({ path: spec.id, message: `${spec.name} must be at least ${spec.min}.` });
        }
        if (spec.max !== undefined && value > spec.max) {
          issues.push({ path: spec.id, message: `${spec.name} must be at most ${spec.max}.` });
        }
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          issues.push({ path: spec.id, message: `${spec.name} must be true or false.` });
        }
        break;
      }
      case 'enum': {
        if (
          typeof value !== 'string' ||
          !spec.options.some((option) => option.value === value)
        ) {
          issues.push({
            path: spec.id,
            message: `${spec.name} must be one of the declared options.`,
          });
        }
        break;
      }
      case 'file-reference': {
        const parsed = FileReferenceParameterValueSchema.safeParse(value);
        if (!parsed.success) {
          issues.push({
            path: spec.id,
            message: `${spec.name} must select a Project File Reference.`,
          });
        }
        break;
      }
    }
  }

  for (const key of Object.keys(parameters)) {
    if (!specs.has(key)) {
      issues.push({ path: key, message: `Unknown parameter "${key}".` });
    }
  }

  return issues;
}

export interface ConnectionCandidate {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface ConnectionValidation {
  valid: boolean;
  reason?: string;
}

function reaches(
  edges: readonly WorkflowEdge[],
  from: string,
  to: string,
  visited = new Set<string>(),
): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);

  for (const edge of edges) {
    if (edge.source === from && reaches(edges, edge.target, to, visited)) {
      return true;
    }
  }
  return false;
}

/**
 * Decides whether an edge may be added to the Workflow. A connection is valid
 * when both ports exist on the referenced Manifest versions, their kinds match
 * (data to data, control to control), data types are compatible, the target
 * input is free, and the edge would not create a cycle.
 */
export function validateConnection(
  workflow: Pick<WorkflowIR, 'nodes' | 'edges'>,
  manifests: readonly NodeManifest[],
  connection: ConnectionCandidate,
): ConnectionValidation {
  const sourceNode = workflow.nodes.find((node) => node.id === connection.source);
  const targetNode = workflow.nodes.find((node) => node.id === connection.target);

  if (!sourceNode || !targetNode) {
    return { valid: false, reason: 'Both Nodes must exist in the Workflow.' };
  }
  if (sourceNode.id === targetNode.id) {
    return { valid: false, reason: 'A Node cannot connect to itself.' };
  }

  const sourceManifest = findManifest(
    manifests,
    sourceNode.manifestId,
    sourceNode.manifestVersion,
  );
  const targetManifest = findManifest(
    manifests,
    targetNode.manifestId,
    targetNode.manifestVersion,
  );
  if (!sourceManifest || !targetManifest) {
    return { valid: false, reason: 'The Node Manifest version is not available.' };
  }

  const sourcePort = sourceManifest.outputs.find((port) => port.id === connection.sourcePort);
  const targetPort = targetManifest.inputs.find((port) => port.id === connection.targetPort);

  if (!sourcePort) {
    return { valid: false, reason: 'The source Node has no such output port.' };
  }
  if (!targetPort) {
    return { valid: false, reason: 'The target Node has no such input port.' };
  }
  if (sourcePort.kind !== targetPort.kind) {
    return { valid: false, reason: 'Control and data ports cannot be connected.' };
  }
  if (
    sourcePort.kind === 'data' &&
    sourcePort.dataType !== targetPort.dataType &&
    sourcePort.dataType !== 'any' &&
    targetPort.dataType !== 'any'
  ) {
    return {
      valid: false,
      reason: `Cannot connect ${sourcePort.dataType ?? 'data'} to ${targetPort.dataType ?? 'data'}.`,
    };
  }

  const targetOccupied = workflow.edges.some(
    (edge) =>
      edge.target === connection.target && edge.targetPort === connection.targetPort,
  );
  if (targetOccupied) {
    return { valid: false, reason: 'The target input port is already connected.' };
  }

  if (reaches(workflow.edges, connection.target, connection.source)) {
    return { valid: false, reason: 'The connection would create a cycle.' };
  }

  return { valid: true };
}
