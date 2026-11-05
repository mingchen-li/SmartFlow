import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  FileReference,
  NodeManifest,
  WorkflowDraft,
  WorkflowIR,
} from '@sflow/domain';
import {
  AGENT_FLOAT_BALL_SIZE,
  AGENT_FLOAT_MAX_WIDTH,
  AGENT_FLOAT_MIN_HEIGHT,
  AGENT_FLOAT_MIN_WIDTH,
  useLayoutStore,
  type FloatingPoint,
  type FloatingSize,
} from '../store/layout';
import { AgentSurface } from './AgentSurface';

const TOOLBAR_HEIGHT = 52;
const MARGIN = 8;
const TOP_MIN = TOOLBAR_HEIGHT + MARGIN;
const PANEL_MIN_TOP = 140;
const DRAG_THRESHOLD = 4;

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const RESIZE_DIRECTIONS: ResizeDirection[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

export interface FloatingAgentProps {
  draftId: string;
  manifests: readonly NodeManifest[];
  fileReferences: readonly FileReference[];
  saveNow: () => Promise<WorkflowDraft | null>;
  onWorkflowApplied: (workflow: WorkflowIR, revision: number) => void;
  onNotify: (message: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), value));
}

function clampBallPoint(point: FloatingPoint): FloatingPoint {
  return {
    x: clamp(point.x, MARGIN, window.innerWidth - AGENT_FLOAT_BALL_SIZE - MARGIN),
    y: clamp(point.y, TOP_MIN, window.innerHeight - AGENT_FLOAT_BALL_SIZE - MARGIN),
  };
}

function clampPanelPoint(point: FloatingPoint, size: FloatingSize): FloatingPoint {
  return {
    x: clamp(point.x, MARGIN, window.innerWidth - size.width - MARGIN),
    y: clamp(point.y, TOP_MIN, window.innerHeight - size.height - MARGIN),
  };
}

function clampPanelSize(size: FloatingSize): FloatingSize {
  const maxWidth = Math.max(
    AGENT_FLOAT_MIN_WIDTH,
    Math.min(AGENT_FLOAT_MAX_WIDTH, window.innerWidth - 2 * MARGIN),
  );
  const maxHeight = Math.max(
    AGENT_FLOAT_MIN_HEIGHT,
    window.innerHeight - TOP_MIN - MARGIN,
  );
  return {
    width: clamp(size.width, AGENT_FLOAT_MIN_WIDTH, maxWidth),
    height: clamp(size.height, AGENT_FLOAT_MIN_HEIGHT, maxHeight),
  };
}

function defaultBallPoint(): FloatingPoint {
  return {
    x: window.innerWidth - AGENT_FLOAT_BALL_SIZE - 16,
    y: window.innerHeight - AGENT_FLOAT_BALL_SIZE - 16,
  };
}

function defaultPanelPoint(size: FloatingSize): FloatingPoint {
  return {
    x: Math.max(MARGIN, (window.innerWidth - size.width) / 2),
    y: PANEL_MIN_TOP,
  };
}

interface BallDrag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPoint;
  moved: boolean;
}

interface PanelDrag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPoint;
}

interface ResizeSession {
  pointerId: number;
  direction: ResizeDirection;
  startX: number;
  startY: number;
  originPosition: FloatingPoint;
  originSize: FloatingSize;
}

/**
 * Maximize-mode Agent presentation. A draggable floating ball expands into a
 * draggable, edge/corner-resizable panel and collapses back to the ball. Ball
 * and panel geometry, plus expansion state, live only in the layout store, so
 * they never enter Workflow IR, EditorLayout, or Run snapshots.
 */
export function FloatingAgent(props: FloatingAgentProps) {
  const open = useLayoutStore((state) => state.agentFloatOpen);
  const setOpen = useLayoutStore((state) => state.setAgentFloatOpen);
  const storedBall = useLayoutStore((state) => state.agentBallPosition);
  const setBall = useLayoutStore((state) => state.setAgentBallPosition);
  const storedPanel = useLayoutStore((state) => state.agentPanelPosition);
  const setPanel = useLayoutStore((state) => state.setAgentPanelPosition);
  const storedSize = useLayoutStore((state) => state.agentPanelSize);
  const setSize = useLayoutStore((state) => state.setAgentPanelSize);

  const ballDrag = useRef<BallDrag | null>(null);
  const panelDrag = useRef<PanelDrag | null>(null);
  const resizeSession = useRef<ResizeSession | null>(null);

  const size = clampPanelSize(storedSize);
  const ball = clampBallPoint(storedBall ?? defaultBallPoint());
  const panel = clampPanelPoint(storedPanel ?? defaultPanelPoint(size), size);

  function onBallPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    ballDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: ball,
      moved: false,
    };
  }

  function onBallPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = ballDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    drag.moved = true;
    setBall(clampBallPoint({ x: drag.origin.x + dx, y: drag.origin.y + dy }));
  }

  function onBallPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = ballDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    ballDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A click, not a drag, expands the Agent.
    if (!drag.moved) setOpen(true);
  }

  function onBallPointerCancel(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (ballDrag.current?.pointerId !== event.pointerId) return;
    ballDrag.current = null;
  }

  function onPanelPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: panel,
    };
  }

  function onPanelPointerMove(event: ReactPointerEvent<HTMLElement>): void {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPanel(
      clampPanelPoint(
        {
          x: drag.origin.x + event.clientX - drag.startX,
          y: drag.origin.y + event.clientY - drag.startY,
        },
        size,
      ),
    );
  }

  function onPanelPointerUp(event: ReactPointerEvent<HTMLElement>): void {
    if (panelDrag.current?.pointerId !== event.pointerId) return;
    panelDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onResizePointerDown(
    direction: ResizeDirection,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeSession.current = {
      pointerId: event.pointerId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      originPosition: panel,
      originSize: size,
    };
  }

  function onResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = resizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const { direction, originPosition, originSize } = session;

    let width = originSize.width;
    let height = originSize.height;
    if (direction.includes('e')) width = originSize.width + dx;
    if (direction.includes('s')) height = originSize.height + dy;
    if (direction.includes('w')) width = originSize.width - dx;
    if (direction.includes('n')) height = originSize.height - dy;

    width = clamp(width, AGENT_FLOAT_MIN_WIDTH, AGENT_FLOAT_MAX_WIDTH);
    height = clamp(
      height,
      AGENT_FLOAT_MIN_HEIGHT,
      Math.max(AGENT_FLOAT_MIN_HEIGHT, window.innerHeight - TOP_MIN - MARGIN),
    );

    let left = originPosition.x;
    let top = originPosition.y;
    if (direction.includes('w')) left = originPosition.x + originSize.width - width;
    if (direction.includes('n')) top = originPosition.y + originSize.height - height;

    left = clamp(left, MARGIN, window.innerWidth - width - MARGIN);
    top = clamp(top, TOP_MIN, window.innerHeight - height - MARGIN);

    // Keep the panel inside the viewport in both axes.
    width = Math.max(
      AGENT_FLOAT_MIN_WIDTH,
      Math.min(width, window.innerWidth - left - MARGIN),
    );
    height = Math.max(
      Math.min(AGENT_FLOAT_MIN_HEIGHT, window.innerHeight - top - MARGIN),
      Math.min(height, window.innerHeight - top - MARGIN),
    );

    setPanel({ x: left, y: top });
    setSize({ width, height });
  }

  function onResizePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resizeSession.current?.pointerId !== event.pointerId) return;
    resizeSession.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="agent-ball"
        style={{ left: ball.x, top: ball.y }}
        aria-label="Open Agent"
        data-testid="agent-ball"
        onPointerDown={onBallPointerDown}
        onPointerMove={onBallPointerMove}
        onPointerUp={onBallPointerUp}
        onPointerCancel={onBallPointerCancel}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="agent-ball-label" aria-hidden="true">
          AI
        </span>
      </button>
    );
  }

  return (
    <div
      className="agent-floating-panel"
      style={{
        left: panel.x,
        top: panel.y,
        width: size.width,
        height: size.height,
      }}
      role="dialog"
      aria-label="Agent floating panel"
      data-testid="agent-floating-panel"
    >
      <header
        className="agent-float-header"
        data-testid="agent-float-header"
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={onPanelPointerUp}
        onPointerCancel={onPanelPointerUp}
      >
        <span className="agent-float-title">Agent</span>
        <button
          type="button"
          className="button button-ghost button-icon"
          aria-label="Collapse Agent to floating ball"
          onClick={() => setOpen(false)}
          data-testid="agent-float-collapse"
        >
          ×
        </button>
      </header>

      <AgentSurface {...props} />

      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`agent-resize-handle agent-resize-${direction}`}
          data-testid={`agent-resize-${direction}`}
          data-direction={direction}
          aria-hidden="true"
          onPointerDown={(event) => onResizePointerDown(direction, event)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        />
      ))}
    </div>
  );
}
