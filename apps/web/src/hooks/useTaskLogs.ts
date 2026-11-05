import { useEffect, useState } from 'react';
import type { Task, TaskLogsResponse } from '@sflow/domain';
import { getTaskLogs } from '../api';

/**
 * Fetches line-oriented logs for every Task attempt that has them. The
 * signature keeps the effect stable across unrelated Run polling updates while
 * still refreshing when a Task gains or changes its log file.
 */
export function useTaskLogs(
  runId: string | null,
  tasks: readonly Task[] | undefined,
): Record<string, TaskLogsResponse> {
  const [logs, setLogs] = useState<Record<string, TaskLogsResponse>>({});
  const signature = (tasks ?? [])
    .filter((task) => task.logsAvailable)
    .map((task) => `${task.id}:${task.state}:${task.updatedAt}`)
    .join('|');

  useEffect(() => {
    if (!runId) {
      setLogs({});
      return;
    }

    let cancelled = false;
    const available = (tasks ?? []).filter((task) => task.logsAvailable);
    if (available.length === 0) {
      setLogs({});
      return;
    }

    void Promise.all(
      available.map(async (task) => {
        try {
          const response = await getTaskLogs(runId, task.id);
          return [task.id, response] as const;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setLogs(
        Object.fromEntries(
          entries.filter(
            (entry): entry is readonly [string, TaskLogsResponse] => entry !== undefined,
          ),
        ),
      );
    });

    return () => {
      cancelled = true;
    };
    // `signature` captures the log-relevant Task state; `tasks` is deliberately
    // not a dependency because polling recreates the array every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, signature]);

  return logs;
}
