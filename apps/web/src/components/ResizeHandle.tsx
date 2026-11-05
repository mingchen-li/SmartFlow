import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface ResizeHandleProps {
  label: string;
  orientation?: 'left' | 'right';
  onResizeBy: (delta: number) => void;
  testId?: string;
}

/**
 * A keyboard- and pointer-accessible vertical resize handle. The caller owns
 * the width; the handle reports deltas so the same component can sit on either
 * side of the editor.
 */
export function ResizeHandle({
  label,
  orientation = 'right',
  onResizeBy,
  testId,
}: ResizeHandleProps) {
  const dragStart = useRef<number | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    dragStart.current = event.clientX;

    const move = (moveEvent: PointerEvent): void => {
      if (dragStart.current === null) return;
      const direction = orientation === 'right' ? 1 : -1;
      const delta = (moveEvent.clientX - dragStart.current) * direction;
      if (delta !== 0) {
        dragStart.current = moveEvent.clientX;
        onResizeBy(delta);
      }
    };

    const stop = (): void => {
      dragStart.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const direction = orientation === 'right' ? 1 : -1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onResizeBy(16 * direction);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onResizeBy(-16 * direction);
    }
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
