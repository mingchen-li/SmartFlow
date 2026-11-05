import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { findManifest, type FileReference, type NodeManifest } from '@sflow/domain';
import { useEditorStore } from '../store/editor';
import { NodeInspector } from './NodeInspector';

type AgentContext = 'workflow' | 'node';

interface AgentMessage {
  id: number;
  role: 'agent' | 'user';
  text: string;
}

export interface AgentPanelProps {
  width: number;
  onCollapse: () => void;
  manifests: readonly NodeManifest[];
  fileReferences: readonly FileReference[];
}

/**
 * Agent surface: context switch, conversation history, generated Node
 * configuration for the selected Node, and a fixed composer. Model responses
 * and Agent-driven edits land in ticket #15.
 */
export function AgentPanel({
  width,
  onCollapse,
  manifests,
  fileReferences,
}: AgentPanelProps) {
  const [context, setContext] = useState<AgentContext>('workflow');
  const [composer, setComposer] = useState('');
  const nextMessageId = useRef(2);
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: 1,
      role: 'agent',
      text: 'Ask about this Binder design Workflow. Selecting a Node will switch me into that Node context.',
    },
  ]);

  const workflow = useEditorStore((state) => state.workflow);
  const selectedNodeId = useEditorStore((state) => state.layout.selection.nodeId);
  const selectedNode =
    selectedNodeId === null
      ? undefined
      : workflow.nodes.find((node) => node.id === selectedNodeId);
  const selectedManifest = selectedNode
    ? findManifest(manifests, selectedNode.manifestId, selectedNode.manifestVersion)
    : undefined;

  useEffect(() => {
    if (selectedNodeId) setContext('node');
  }, [selectedNodeId]);

  function send(): void {
    const text = composer.trim();
    if (!text) return;

    const userMessage: AgentMessage = { id: nextMessageId.current++, role: 'user', text };
    const notice: AgentMessage = {
      id: nextMessageId.current++,
      role: 'agent',
      text: 'Agent responses are not available yet. Your message was not sent to a model.',
    };

    setMessages((current) => [...current, userMessage, notice]);
    setComposer('');
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  const contextLabel = context === 'workflow' ? 'Workflow' : 'Selected Node';

  return (
    <aside
      className="panel agent-panel"
      style={{ width }}
      aria-label="Agent"
      data-testid="agent-panel"
    >
      <header className="panel-header">
        <span>Agent</span>
        <span className="panel-header-actions">
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label="Collapse agent panel"
            onClick={onCollapse}
          >
            ›
          </button>
        </span>
      </header>

      <div className="agent-body" data-testid="agent-messages">
        <div className="agent-context" role="group" aria-label="Agent context">
          <span className="segmented">
            <button
              type="button"
              aria-pressed={context === 'workflow'}
              data-testid="agent-context-workflow"
              onClick={() => setContext('workflow')}
            >
              Workflow Agent
            </button>
            <button
              type="button"
              aria-pressed={context === 'node'}
              data-testid="agent-context-node"
              onClick={() => setContext('node')}
            >
              Node Agent
            </button>
          </span>
        </div>

        <p className="muted">{`Context: ${contextLabel}`}</p>

        {messages.map((message) => (
          <div
            key={message.id}
            className={`agent-message${message.role === 'user' ? ' agent-message-user' : ''}`}
          >
            {message.text}
          </div>
        ))}
      </div>

      {selectedNode && selectedManifest ? (
        <NodeInspector
          instance={selectedNode}
          manifest={selectedManifest}
          fileReferences={fileReferences}
        />
      ) : null}

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
    </aside>
  );
}
