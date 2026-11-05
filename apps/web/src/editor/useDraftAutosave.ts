import { useCallback, useEffect } from 'react';
import type { SaveWorkflowDraftRequest, WorkflowDraft } from '@sflow/domain';
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
  /**
   * Saves immediately and returns the persisted draft (including its Workflow
   * IR revision), or null when hydration or the request failed.
   */
  saveNow: (options?: { notify?: boolean }) => Promise<WorkflowDraft | null>;
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
    async ({ notify = false }: { notify?: boolean } = {}): Promise<WorkflowDraft | null> => {
      // Explicit Save may be clicked before the initial draft GET settles.
      // Wait briefly so an existing draft is never overwritten with defaults.
      const deadline = Date.now() + 5_000;
      while (!useEditorStore.getState().hydrated && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 25);
        });
      }

      const state = useEditorStore.getState();
      if (!state.hydrated) return null;

      const savedRevisionAtStart = state.revision;
      const payload: SaveWorkflowDraftRequest = {
        name: state.draftName,
        workflow: state.workflow,
        layout: state.layout,
      };

      state.setSaveState('saving');
      try {
        const saved = await saveWorkflow(draftId, payload);
        useEditorStore.getState().markSaved(savedRevisionAtStart, saved.revision);
        if (notify) onSaved?.();
        return saved;
      } catch {
        useEditorStore.getState().setSaveState('error');
        if (notify) onError?.();
        return null;
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
