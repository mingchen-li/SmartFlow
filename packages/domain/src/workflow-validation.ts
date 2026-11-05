import { z } from 'zod';
import {
  NodeResourcesSchema,
  WorkflowIRSchema,
  findManifest,
  validateParameters,
  type NodeManifest,
  type NodePort,
  type WorkflowEdge,
  type WorkflowIR,
} from './workflow';

/**
 * Pure Workflow validation shared by the Project Server, Orchestrator, and
 * future Agent integrations. It never reads the draft, the layout, or any
 * runtime state: the caller supplies the Workflow IR and the installed
 * Manifests, and receives actionable diagnostics.
 */

export const ValidationDiagnosticCodeSchema = z.enum([
  'INVALID_WORKFLOW',
  'UNKNOWN_MANIFEST',
  'INVALID_PORT',
  'MISSING_INPUT',
  'DUPLICATE_INPUT',
  'INVALID_CONNECTION',
  'UNSATISFIED_DEPENDENCY',
  'CYCLE',
  'PARAMETER_ERROR',
  'RESOURCE_ERROR',
  'MISSING_BINDER_OUTPUT',
  'PATCH_APPLICATION_ERROR',
]);
export type ValidationDiagnosticCode = z.infer<typeof ValidationDiagnosticCodeSchema>;

export const ValidationDiagnosticSeveritySchema = z.enum(['error', 'warning']);
export type ValidationDiagnosticSeverity = z.infer<typeof ValidationDiagnosticSeveritySchema>;

/**
 * One validation finding. `nodeId`/`edgeId` identify the affected execution
 * object when one exists; `path` points into the Workflow draft;
 * `correction` tells the user what to change.
 */
export const ValidationDiagnosticSchema = z.strictObject({
  severity: ValidationDiagnosticSeveritySchema,
  code: ValidationDiagnosticCodeSchema,
  message: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  edgeId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  correction: z.string().min(1),
});
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnosticSchema>;

export const ValidateWorkflowResponseSchema = z.strictObject({
  valid: z.boolean(),
  diagnostics: z.array(ValidationDiagnosticSchema),
});
export type ValidateWorkflowResponse = z.infer<typeof ValidateWorkflowResponseSchema>;

/** An output the Workflow must be able to produce before a Run may start. */
export interface RequiredWorkflowOutput {
  manifestId: string;
  portId: string;
  label: string;
  correction: string;
}

/**
 * The Binder path is only executable when it can produce a ranked candidate
 * set and a comparison report. This is policy, not schema: callers may supply
 * their own required outputs.
 */
export const BINDER_REQUIRED_OUTPUTS: readonly RequiredWorkflowOutput[] = [
  {
    manifestId: 'candidate-comparison',
    portId: 'ranking',
    label: 'Ranked candidates',
    correction:
      'Insert a Candidate comparison Node and connect the scored candidate set into it.',
  },
  {
    manifestId: 'candidate-comparison',
    portId: 'report',
    label: 'Comparison report',
    correction:
      'Insert a Candidate comparison Node and connect the scored candidate set into it.',
  },
];

export interface ValidateWorkflowOptions {
  requiredOutputs?: readonly RequiredWorkflowOutput[];
}

function error(partial: Omit<ValidationDiagnostic, 'severity'>): ValidationDiagnostic {
  return { severity: 'error', ...partial };
}

function portList(ports: readonly NodePort[]): string {
  return ports.length === 0 ? 'none' : ports.map((port) => port.id).join(', ');
}

function targetCorrection(port: NodePort, nodeLabel: string): string {
  return port.kind === 'data'
    ? `Connect an output with data type "${port.dataType ?? 'data'}" to "${port.id}" on "${nodeLabel}".`
    : `Connect a control output to "${port.id}" on "${nodeLabel}".`;
}

/**
 * Classifies a Workflow IR schema failure so parameter and resource problems
 * still surface as their specific diagnostic codes, and attaches the affected
 * Node or connection when the raw draft is readable enough to identify it.
 */
interface SchemaIssue {
  path: PropertyKey[];
  message: string;
}

function schemaDiagnostics(
  workflow: unknown,
  issues: readonly SchemaIssue[],
): ValidationDiagnostic[] {
  const record =
    typeof workflow === 'object' && workflow !== null
      ? (workflow as Record<string, unknown>)
      : {};

  return issues.map((issue) => {
    const path = issue.path.map(String);
    // Zod reports strict-object unrecognized keys on the parent path; surface
    // the offending key so layout state leaking into IR is directly fixable.
    const unrecognizedKey = issue.message.match(/Unrecognized key: "(.+?)"/)?.[1];
    const pathString = path.join('.') || unrecognizedKey || '';
    const index = issue.path[1];
    const collection = issue.path[0];

    const nodeId = (() => {
      if (collection !== 'nodes' || typeof index !== 'number') return undefined;
      const nodes = record.nodes;
      if (!Array.isArray(nodes)) return undefined;
      const candidate = nodes[index] as { id?: unknown } | undefined;
      return typeof candidate?.id === 'string' ? candidate.id : undefined;
    })();

    const edgeId = (() => {
      if (collection !== 'edges' || typeof index !== 'number') return undefined;
      const edges = record.edges;
      if (!Array.isArray(edges)) return undefined;
      const candidate = edges[index] as { id?: unknown } | undefined;
      return typeof candidate?.id === 'string' ? candidate.id : undefined;
    })();

    const inParameters = path.includes('parameters');
    const inResources = path.includes('resources');
    const code: ValidationDiagnosticCode = inParameters
      ? 'PARAMETER_ERROR'
      : inResources
        ? 'RESOURCE_ERROR'
        : 'INVALID_WORKFLOW';

    const correction = inParameters
      ? `Correct "${pathString}" to match the Node Manifest parameter schema.`
      : inResources
        ? `Correct "${pathString}" to a valid resource declaration.`
        : `Fix "${pathString || 'the Workflow'}" and validate again.`;

    return error({
      code,
      message: `The Workflow draft is invalid at "${pathString || 'workflow'}": ${issue.message}`,
      correction,
      ...(nodeId ? { nodeId } : {}),
      ...(edgeId ? { edgeId } : {}),
      path: pathString || 'workflow',
    });
  });
}

interface DirectedEdge {
  edge: WorkflowEdge;
  source: string;
  target: string;
}

/** Tarjan strongly-connected components over Node ids. */
function stronglyConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly DirectedEdge[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function visit(node: string): void {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) visit(id);
  }

  return components;
}

function findCycle(
  nodes: readonly WorkflowIR['nodes'][number][],
  edges: readonly DirectedEdge[],
): { nodeIds: string[]; edgeId?: string } | undefined {
  const components = stronglyConnectedComponents(
    nodes.map((node) => node.id),
    edges,
  );

  for (const component of components) {
    const members = new Set(component);
    const internalEdges = edges.filter(
      (edge) => members.has(edge.source) && members.has(edge.target),
    );
    const isSelfLoop =
      component.length === 1 &&
      internalEdges.some((edge) => edge.source === edge.target);
    if (component.length > 1 || isSelfLoop) {
      return { nodeIds: component, edgeId: internalEdges[0]?.edge.id };
    }
  }

  return undefined;
}

/**
 * Validates ports, required inputs, parameters, resources, dependencies,
 * cycles, and required outputs. The returned diagnostics are ordered by
 * Workflow position so the editor can present them stably.
 */
export function validateWorkflow(
  workflow: unknown,
  manifests: readonly NodeManifest[],
  options: ValidateWorkflowOptions = {},
): ValidateWorkflowResponse {
  const parsed = WorkflowIRSchema.safeParse(workflow);
  if (!parsed.success) {
    const diagnostics = schemaDiagnostics(workflow, parsed.error.issues);
    return { valid: false, diagnostics };
  }

  const ir = parsed.data;
  const diagnostics: ValidationDiagnostic[] = [];
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const nodeIndexById = new Map(ir.nodes.map((node, index) => [node.id, index]));
  const manifestByNodeId = new Map<string, NodeManifest>();

  for (const [index, node] of ir.nodes.entries()) {
    const manifest = findManifest(manifests, node.manifestId, node.manifestVersion);
    if (!manifest) {
      diagnostics.push(
        error({
          code: 'UNKNOWN_MANIFEST',
          nodeId: node.id,
          path: `nodes.${index}.manifestId`,
          message: `Node "${node.label}" references Manifest "${node.manifestId}@${node.manifestVersion}", which is not installed.`,
          correction: `Install "${node.manifestId}@${node.manifestVersion}" or change the Node to an installed Manifest version.`,
        }),
      );
      continue;
    }
    manifestByNodeId.set(node.id, manifest);

    for (const issue of validateParameters(manifest, node.parameters)) {
      diagnostics.push(
        error({
          code: 'PARAMETER_ERROR',
          nodeId: node.id,
          path: `nodes.${index}.parameters.${issue.path}`,
          message: `Node "${node.label}" has an invalid parameter: ${issue.message}`,
          correction: `Correct parameter "${issue.path}" on Node "${node.label}" to match its Manifest declaration.`,
        }),
      );
    }

    const resources = NodeResourcesSchema.safeParse(node.resources);
    if (!resources.success) {
      for (const issue of resources.error.issues) {
        diagnostics.push(
          error({
            code: 'RESOURCE_ERROR',
            nodeId: node.id,
            path: `nodes.${index}.resources.${issue.path.map(String).join('.')}`,
            message: `Node "${node.label}" has an invalid resource declaration: ${issue.message}`,
            correction: `Correct the resource overrides on Node "${node.label}" to a valid declaration.`,
          }),
        );
      }
    } else {
      const resolvedGpu = node.resources.gpu ?? manifest.resources.gpu ?? 0;
      if (resources.data.gpuType !== undefined && resolvedGpu <= 0) {
        diagnostics.push(
          error({
            code: 'RESOURCE_ERROR',
            nodeId: node.id,
            path: `nodes.${index}.resources.gpuType`,
            message: `Node "${node.label}" declares GPU type "${resources.data.gpuType}" without requesting a GPU.`,
            correction: `Set a GPU count above 0 on Node "${node.label}" or remove the GPU type.`,
          }),
        );
      }
    }

    for (const port of manifest.inputs) {
      if (port.required !== true) continue;
      const connected = ir.edges.some(
        (edge) => edge.target === node.id && edge.targetPort === port.id,
      );
      if (!connected) {
        diagnostics.push(
          error({
            code: 'MISSING_INPUT',
            nodeId: node.id,
            path: `nodes.${index}.inputs.${port.id}`,
            message: `Node "${node.label}" requires input "${port.name}" ("${port.id}"), but nothing is connected.`,
            correction: targetCorrection(port, node.label),
          }),
        );
      }
    }
  }

  for (const [index, edge] of ir.edges.entries()) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);

    if (!sourceNode) {
      diagnostics.push(
        error({
          code: 'UNSATISFIED_DEPENDENCY',
          edgeId: edge.id,
          path: `edges.${index}.source`,
          message: `Connection "${edge.id}" starts from Node "${edge.source}", which is not in the Workflow.`,
          correction: 'Remove the connection or restore the missing source Node.',
        }),
      );
      continue;
    }
    if (!targetNode) {
      diagnostics.push(
        error({
          code: 'UNSATISFIED_DEPENDENCY',
          edgeId: edge.id,
          path: `edges.${index}.target`,
          message: `Connection "${edge.id}" targets Node "${edge.target}", which is not in the Workflow.`,
          correction: 'Remove the connection or restore the missing target Node.',
        }),
      );
      continue;
    }

    const sourceManifest = manifestByNodeId.get(edge.source);
    const targetManifest = manifestByNodeId.get(edge.target);
    if (!sourceManifest || !targetManifest) continue;

    const sourcePort = sourceManifest.outputs.find((port) => port.id === edge.sourcePort);
    const targetPort = targetManifest.inputs.find((port) => port.id === edge.targetPort);

    if (!sourcePort) {
      diagnostics.push(
        error({
          code: 'INVALID_PORT',
          nodeId: sourceNode.id,
          edgeId: edge.id,
          path: `edges.${index}.sourcePort`,
          message: `Connection "${edge.id}" uses output port "${edge.sourcePort}", which Node "${sourceNode.label}" does not declare.`,
          correction: `Connect from one of the declared outputs on "${sourceNode.label}": ${portList(sourceManifest.outputs)}.`,
        }),
      );
      continue;
    }
    if (!targetPort) {
      diagnostics.push(
        error({
          code: 'INVALID_PORT',
          nodeId: targetNode.id,
          edgeId: edge.id,
          path: `edges.${index}.targetPort`,
          message: `Connection "${edge.id}" uses input port "${edge.targetPort}", which Node "${targetNode.label}" does not declare.`,
          correction: `Connect to one of the declared inputs on "${targetNode.label}": ${portList(targetManifest.inputs)}.`,
        }),
      );
      continue;
    }

    if (sourcePort.kind !== targetPort.kind) {
      diagnostics.push(
        error({
          code: 'INVALID_CONNECTION',
          nodeId: targetNode.id,
          edgeId: edge.id,
          path: `edges.${index}.targetPort`,
          message: `Connection "${edge.id}" cannot connect ${sourcePort.kind} output "${sourcePort.id}" to ${targetPort.kind} input "${targetPort.id}".`,
          correction: 'Connect ports of the same kind; control ports connect only to control ports.',
        }),
      );
      continue;
    }

    if (
      sourcePort.kind === 'data' &&
      sourcePort.dataType !== targetPort.dataType &&
      sourcePort.dataType !== 'any' &&
      targetPort.dataType !== 'any'
    ) {
      diagnostics.push(
        error({
          code: 'INVALID_CONNECTION',
          nodeId: targetNode.id,
          edgeId: edge.id,
          path: `edges.${index}.targetPort`,
          message: `Connection "${edge.id}" cannot connect "${sourcePort.dataType ?? 'data'}" to "${targetPort.dataType ?? 'data'}".`,
          correction: `Connect an output with data type "${targetPort.dataType ?? 'data'}" to "${targetPort.id}" on "${targetNode.label}".`,
        }),
      );
    }
  }

  const occupiedInputs = new Map<string, WorkflowEdge>();
  for (const edge of ir.edges) {
    const key = `${edge.target}\u0000${edge.targetPort}`;
    const first = occupiedInputs.get(key);
    if (!first) {
      occupiedInputs.set(key, edge);
      continue;
    }

    const targetNode = nodeById.get(edge.target);
    diagnostics.push(
      error({
        code: 'DUPLICATE_INPUT',
        nodeId: targetNode?.id,
        edgeId: edge.id,
        path: `edges.${ir.edges.indexOf(edge)}.targetPort`,
        message: `Input "${edge.targetPort}" on Node "${targetNode?.label ?? edge.target}" is connected more than once.`,
        correction: `Keep exactly one connection into "${edge.targetPort}" on "${targetNode?.label ?? edge.target}".`,
      }),
    );
  }

  const directedEdges = ir.edges
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target))
    .map((edge) => ({ edge, source: edge.source, target: edge.target }));
  const cycle = findCycle(ir.nodes, directedEdges);
  if (cycle) {
    const labels = cycle.nodeIds.map((id) => nodeById.get(id)?.label ?? id);
    diagnostics.push(
      error({
        code: 'CYCLE',
        nodeId: cycle.nodeIds[0],
        ...(cycle.edgeId ? { edgeId: cycle.edgeId } : {}),
        path: 'edges',
        message: `The Workflow contains a dependency cycle through ${labels.map((label) => `"${label}"`).join(', ')}.`,
        correction: 'Remove one connection in the cycle so execution order is well defined.',
      }),
    );
  }

  const requiredOutputs = options.requiredOutputs ?? BINDER_REQUIRED_OUTPUTS;
  const sinkingNode =
    [...ir.nodes].reverse().find(
      (node) => !ir.edges.some((edge) => edge.source === node.id),
    ) ?? ir.nodes.at(-1);

  for (const requirement of requiredOutputs) {
    const producer = ir.nodes.find(
      (node) => node.manifestId === requirement.manifestId,
    );
    if (producer) continue;

    diagnostics.push(
      error({
        ...(sinkingNode ? { nodeId: sinkingNode.id } : {}),
        code: 'MISSING_BINDER_OUTPUT',
        path: 'workflow.outputs',
        message: `The Workflow does not produce the required Binder output "${requirement.label}" because no Node with Manifest "${requirement.manifestId}" is present.`,
        correction: requirement.correction,
      }),
    );
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}
