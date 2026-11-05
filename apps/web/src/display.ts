import type { RunEvent } from '@sflow/domain';

/**
 * Shared display formatting for Run, Task, and Result View surfaces. Keeping
 * one status tone mapping prevents the same failed state from appearing with
 * different badge semantics in different panels.
 */

/** Maps a Run or Task status to its design-system badge tone. */
export function statusTone(status: string | null | undefined): string {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed') return 'badge-destructive';
  if (status === 'queued' || status === 'running') return 'badge-info';
  return 'badge-neutral';
}

/** Renders an ISO timestamp as a stable UTC wall-clock time. */
export function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const time = value.includes('T') ? value.split('T')[1] ?? value : value;
  return time.replace(/Z$/, '').slice(0, 8);
}

/** Renders one append-only Run event as a single log line. */
export function eventLine(event: RunEvent): string {
  const payload =
    event.payload === undefined ? '' : ` ${JSON.stringify(event.payload)}`;
  return `#${event.id} ${formatTime(event.createdAt)} ${event.type}${
    event.taskId ? ` task=${event.taskId}` : ''
  }${payload}`;
}
