import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  findManifest,
  type AgentPatch,
  type FileReference,
  type JsonPatchOperation,
  type NodeManifest,
  type WorkflowDraft,
  type WorkflowIR,
} from '@sflow/domain';
import {
  ApiError,
  applyAgentPatch,
  proposeAgentPatch,
  rejectAgentPatch,
  revertAgentPatch,
} from '../api';
import { useAgentStore } from '../store/agent';
import { useEditorStore } from '../store/editor';
import { AgentPatchCard } from './AgentPatchCard';
import { NodeInspector } from './NodeInspector';

export interface AgentSurfaceProps {
  draftId: string;
  manifests: readonly NodeManifest[];
  fileReferences: readonly FileReference[];
  saveNow: () => Promise<WorkflowDraft | null>;
  onWorkflowApplied: (workflow: WorkflowIR, revision: number) => void;
  onNotify: (message: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The Agent patch request could not be completed.';
}

function isPatchOperationArray(value: unknown): value is JsonPatchOperation[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (operation) =>
        typeof operation === 'object' &&
        operation !== null &&
        typeof (operation as { op?: unknown }).op === 'string' &&
        typeof (operation as { path?: unknown }).path === 'string',
    )
  );
}

/**
 * The Agent's content surface. Context, conversation history, parameter
 * editing, and the patch preview each scroll independently while the composer
 * stays fixed. The Agent has no external model: messages are recorded locally,
 * and Workflow changes flow only through validated, explicitly applied patches.
 */
export function AgentSurface({
  draftId,
  manifests,
  fileReferences,
  saveNow,
  onWorkflowApplied,
  onNotify,
}: AgentSurfaceProps) {
  const mode = useAgentStore((state) => state.mode);
  const setMode = useAgentStore((state) => state.setMode);
  const messagesByContext = useAgentStore((state) => state.messagesByContext);
  const recordExchange = useAgentStore((state) => state.recordExchange);
  const patches = useAgentStore((state) => state.patches);
  const patchErrors = useAgentStore((state) => state.patchErrors);
  const proposalError = useAgentStore((state) => state.proposalError);
  const addPatch = useAgentStore((state) => state.addPatch);
  const updatePatch = useAgentStore((state) => state.updatePatch);
  const setPatchError = useAgentStore((state) => state.setPatchError);
  const setProposalError = useAgentStore((state) => state.setProposalError);

  const draftName = useEditorStore((state) => state.draftName);
  const workflow = useEditorStore((state) => state.workflow);
  const selectedNodeId = useEditorStore((state) => state.layout.selection.nodeId);
  const selectedNode = selectedNodeId
    ? workflow.nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  const selectedManifest = selectedNode
    ? findManifest(manifests, selectedNode.manifestId, selectedNode.manifestVersion)
    : undefined;

  const [composer, setComposer] = useState('');
  const [summary, setSummary] = useState('');
  const [operationsText, setOperationsText] = useState('');
  const [proposing, setProposing] = useState(false);
  const [busyPatchId, setBusyPatchId] = useState<string | null>(null);

  const contextKey =
    mode === 'workflow'
      ? 'workflow'
      : selectedNodeId
        ? `node:${selectedNodeId}`
        : 'node:none';
  const messages = messagesByContext[contextKey] ?? [];

  const greeting = useMemo(() => {
    if (mode === 'workflow') {
      return `Workflow Agent for ${draftName}. Selecting a Node switches me into that Node's context.`;
    }
    if (selectedNode) {
      return `Node Agent for ${selectedNode.label} (${selectedNode.manifestId}). Parameters are editable below.`;
    }
    return 'Node Agent. Select a Node on the canvas to load its context and parameters.';
  }, [draftName, mode, selectedNode]);

  function send(): void {
    const text = composer.trim();
    if (!text) return;

    recordExchange(
      contextKey,
      text,
      'Message recorded. This Project has no external model connected, so no model reply is generated. Use a validated RFC 6902 patch proposal to change the Workflow.',
    );
    setComposer('');
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  async function propose(): Promise<void> {
    if (proposing) return;
    setProposalError(null);

    let operations: JsonPatchOperation[];
    try {
      const parsed: unknown = JSON.parse(operationsText);
      if (!isPatchOperationArray(parsed)) {
        setProposalError(
          'Operations must be a non-empty JSON array of RFC 6902 operations.',
        );
        return;
      }
      operations = parsed;
    } catch (error) {
      setProposalError(
        error instanceof Error
          ? `Operations are not valid JSON: ${error.message}`
          : 'Operations are not valid JSON.',
      );
      return;
    }

    const trimmedSummary = summary.trim();
    if (!trimmedSummary) return;

    setProposing(true);
    try {
      const saved = await saveNow();
      if (!saved) {
        setProposalError(
          'The Workflow draft could not be saved before proposing the patch.',
        );
        return;
      }

      const target =
        mode === 'node' && selectedNode
          ? {
              kind: 'workflow' as const,
              workflowId: draftId,
              nodeId: selectedNode.id,
            }
          : { kind: 'workflow' as const, workflowId: draftId };

      const { patch } = await proposeAgentPatch(draftId, {
        scope: 'workflow',
        target,
        baseRevision: saved.revision,
        summary: trimmedSummary,
        operations,
      });

      addPatch(patch);
      setSummary('');
      setOperationsText('');
      onNotify(
        patch.validation.valid
          ? 'Agent patch proposed and validated.'
          : 'Agent patch rejected by Workflow validation.',
      );
    } catch (error) {
      setProposalError(errorMessage(error));
    } finally {
      setProposing(false);
    }
  }

  async function apply(patch: AgentPatch): Promise<void> {
    if (busyPatchId) return;
    setBusyPatchId(patch.id);
    try {
      // Persist any pending local edit first. If it changed Workflow IR the
      // Server answers 409 instead of silently rebasing this patch.
      const saved = await saveNow();
      if (!saved) {
        setPatchError(
          patch.id,
          'The Workflow draft could not be saved before applying the patch.',
        );
        return;
      }

      const result = await applyAgentPatch(patch.id);
      if (!('workflow' in result)) {
        setPatchError(
          patch.id,
          'The Server returned a Result View patch to the Workflow Agent surface.',
        );
        return;
      }
      updatePatch(result.patch);
      onWorkflowApplied(result.workflow, result.revision);
      onNotify('Agent patch applied to the Workflow draft.');
    } catch (error) {
      setPatchError(patch.id, errorMessage(error));
    } finally {
      setBusyPatchId(null);
    }
  }

  async function revert(patch: AgentPatch): Promise<void> {
    if (busyPatchId) return;
    setBusyPatchId(patch.id);
    try {
      const saved = await saveNow();
      if (!saved) {
        setPatchError(
          patch.id,
          'The Workflow draft could not be saved before reverting the patch.',
        );
        return;
      }

      const result = await revertAgentPatch(patch.id);
      if (!('workflow' in result)) {
        setPatchError(
          patch.id,
          'The Server returned a Result View patch to the Workflow Agent surface.',
        );
        return;
      }
      updatePatch(result.patch);
      onWorkflowApplied(result.workflow, result.revision);
      onNotify('Agent patch reverted; the prior Workflow was restored.');
    } catch (error) {
      setPatchError(patch.id, errorMessage(error));
    } finally {
      setBusyPatchId(null);
    }
  }

  async function reject(patch: AgentPatch): Promise<void> {
    if (busyPatchId) return;
    setBusyPatchId(patch.id);
    try {
      const { patch: rejected } = await rejectAgentPatch(patch.id);
      updatePatch(rejected);
    } catch (error) {
      setPatchError(patch.id, errorMessage(error));
    } finally {
      setBusyPatchId(null);
    }
  }

  const contextCard =
    mode === 'workflow' ? (
      <>
        <strong>{draftName}</strong>
        <span className="agent-context-meta">
          {workflow.nodes.length} Nodes · {workflow.edges.length} Edges
        </span>
      </>
    ) : selectedNode ? (
      <>
        <strong>{selectedNode.label}</strong>
        <span className="agent-context-meta">
          Node {selectedNode.id} · {selectedNode.manifestId}@
          {selectedNode.manifestVersion}
        </span>
      </>
    ) : (
      <>
        <strong>No Node selected</strong>
        <span className="agent-context-meta">
          Select a Node on the canvas to load Node Agent context.
        </span>
      </>
    );

  return (
    <div className="agent-surface">
      <section
        className="agent-context"
        aria-label="Agent context"
        data-testid="agent-context"
      >
        <div className="agent-mode-row">
          <span className="segmented" role="group" aria-label="Agent mode">
            <button
              type="button"
              aria-pressed={mode === 'workflow'}
              data-testid="agent-context-workflow"
              onClick={() => setMode('workflow')}
            >
              Workflow Agent
            </button>
            <button
              type="button"
              aria-pressed={mode === 'node'}
              data-testid="agent-context-node"
              onClick={() => setMode('node')}
            >
              Node Agent
            </button>
          </span>
          <span
            className="badge badge-info agent-mode-indicator"
            data-testid="agent-mode-indicator"
            data-mode={mode}
            role="status"
          >
            {mode === 'workflow' ? 'Workflow Agent' : 'Node Agent'}
          </span>
        </div>
        <div className="agent-context-card" data-testid="agent-context-card">
          {contextCard}
        </div>
      </section>

      <div
        className="agent-messages"
        aria-label="Agent conversation"
        data-testid="agent-messages"
      >
        <div className="agent-message agent-message-agent">{greeting}</div>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`agent-message${message.role === 'user' ? ' agent-message-user' : ''}`}
          >
            {message.text}
          </div>
        ))}
      </div>

      {mode === 'node' && selectedNode && selectedManifest ? (
        <div className="agent-parameters" data-testid="agent-parameters">
          <NodeInspector
            instance={selectedNode}
            manifest={selectedManifest}
            fileReferences={fileReferences}
          />
        </div>
      ) : null}

      <section
        className="agent-patches"
        aria-label="Agent patch proposals"
        data-testid="agent-patches"
      >
        <div className="agent-patch-form">
          <label className="label" htmlFor="agent-patch-summary">
            Patch summary
          </label>
          <input
            id="agent-patch-summary"
            className="input input-sm"
            type="text"
            value={summary}
            placeholder="Increase candidate count"
            onChange={(event) => setSummary(event.target.value)}
            data-testid="agent-patch-summary"
          />
          <label className="label" htmlFor="agent-patch-operations">
            RFC 6902 operations
          </label>
          <textarea
            id="agent-patch-operations"
            className="textarea agent-patch-operations"
            value={operationsText}
            placeholder='[{"op":"replace","path":"/nodes/1/parameters/numCandidates","value":250}]'
            spellCheck={false}
            onChange={(event) => setOperationsText(event.target.value)}
            data-testid="agent-patch-operations"
          />
          <button
            type="button"
            className="button button-sm button-primary"
            disabled={proposing || summary.trim().length === 0}
            aria-busy={proposing}
            onClick={() => void propose()}
            data-testid="agent-patch-propose"
          >
            {proposing ? 'Proposing…' : 'Propose patch'}
          </button>
          {proposalError ? (
            <p
              className="error-text"
              role="alert"
              data-testid="agent-propose-error"
            >
              {proposalError}
            </p>
          ) : null}
        </div>

        {patches.length === 0 ? (
          <p className="muted agent-patch-empty">
            No Agent patches yet. Proposals are validated against the Workflow
            before they can be applied.
          </p>
        ) : (
          patches.map((patch) => (
            <AgentPatchCard
              key={patch.id}
              patch={patch}
              error={patchErrors[patch.id]}
              busy={busyPatchId === patch.id}
              onApply={() => void apply(patch)}
              onReject={() => void reject(patch)}
              onRevert={() => void revert(patch)}
            />
          ))
        )}
      </section>

      <div className="agent-composer">
        <label className="sr-only" htmlFor="agent-composer">
          Message the Agent
        </label>
        <textarea
          id="agent-composer"
          className="textarea"
          placeholder="Ask the Agent about this workflow…"
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={onComposerKeyDown}
          data-testid="agent-composer-input"
        />
        <button
          type="button"
          className="button button-primary"
          disabled={composer.trim().length === 0}
          onClick={send}
          data-testid="agent-send"
        >
          Send
        </button>
      </div>
    </div>
  );
}
