import { useCallback, useEffect } from 'react';
import type { SaveWorkflowDraftRequest } from '@sflow/domain';
import { saveWorkflow } from '../api';
import { useEditorStore } from '../store/editor';

export const AUTOSAVE_DELAY_MS = 650;

export interface AutosaveOptions {
  draftId: string;
  delayMs?: number;
  onSaved?: () => void;
  onError?: () => void;
}

export interface AutosaveController {
  saveNow: (options?: { notify?: boolean }) => Promise<boolean>;
}

/**
 * Debounced autosave plus an explicit Save path. The editor store's revision
 * counter ensures hydration and runtime UI changes never trigger a write; a
 * save that races a newer edit leaves the newer revision scheduled.
 */
export function useDraftAutosave({
  draftId,
  delayMs = AUTOSAVE_DELAY_MS,
  onSaved,
  onError,
}: AutosaveOptions): AutosaveController {
  const hydrated = useEditorStore((state) => state.hydrated);
  const revision = useEditorStore((state) => state.revision);
  const savedRevision = useEditorStore((state) => state.savedRevision);

  const saveNow = useCallback(
    async ({ notify = false }: { notify?: boolean } = {}): Promise<boolean> => {
      // Explicit Save may be clicked before the initial draft GET settles.
      // Wait briefly so an existing draft is never overwritten with defaults.
      const deadline = Date.now() + 5_000;
      while (!useEditorStore.getState().hydrated && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 25);
        });
      }

      const state = useEditorStore.getState();
      if (!state.hydrated) return false;

      const savedRevisionAtStart = state.revision;
      const payload: SaveWorkflowDraftRequest = {
        name: state.draftName,
        workflow: state.workflow,
        layout: state.layout,
      };

      state.setSaveState('saving');
      try {
        await saveWorkflow(draftId, payload);
        useEditorStore.getState().markSaved(savedRevisionAtStart);
        if (notify) onSaved?.();
        return true;
      } catch {
        useEditorStore.getState().setSaveState('error');
        if (notify) onError?.();
        return false;
      }
    },
    [draftId, onError, onSaved],
  );

  useEffect(() => {
    if (!hydrated || revision === savedRevision) return;

    useEditorStore.getState().setSaveState('saving');
    const timeout = window.setTimeout(() => {
      void saveNow();
    }, delayMs);

    return () => window.clearTimeout(timeout);
  }, [delayMs, hydrated, revision, saveNow, savedRevision]);

  return { saveNow };
}
