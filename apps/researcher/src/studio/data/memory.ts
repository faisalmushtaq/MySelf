import { useCallback, useMemo, useRef, useState } from "react";
import type { StudioDraft } from "@myself/studio";
import { record, redo, redoLabel, startHistory, undo, undoLabel, type History } from "./history.js";
import type { DraftEditor } from "./types.js";

/**
 * A draft editor with no server: the whole DraftEditor contract, held in
 * memory.
 *
 * Used by the playground route (the live survey, editable, with nothing saved
 * anywhere) and by tests, so the editor screens can be built and exercised
 * without a Firebase project, and so it is obvious which behaviour belongs to
 * the screens and which to saving.
 *
 * The history lives in a ref as well as in state. Two edits in the same tick
 * (a paste followed by a blur, say) must each start from the result of the
 * one before; reading the draft from the last render would lose the first.
 */
export function useMemoryDraftEditor(initial: StudioDraft | null, options: { readOnly?: boolean } = {}): DraftEditor {
  const ref = useRef<History | null>(initial ? startHistory(initial) : null);
  const [history, setHistory] = useState<History | null>(ref.current);

  const commit = useCallback((next: History | null) => {
    ref.current = next;
    setHistory(next);
  }, []);

  const apply = useCallback(
    (change: (draft: StudioDraft) => StudioDraft, label: string) => {
      const h = ref.current;
      if (!h || options.readOnly) return;
      // Runs here, not inside a state updater, so a StudioOpError reaches the
      // caller synchronously and the draft is left untouched.
      commit(record(h, change(h.present), label, Date.now()));
    },
    [commit, options.readOnly],
  );

  return useMemo<DraftEditor>(
    () => ({
      status: history ? "ready" : "missing",
      error: null,
      draft: history?.present ?? null,
      revision: 0,
      basedOn: null,
      save: { kind: "saved", at: null },
      readOnly: options.readOnly ?? false,
      hasUnsavedChanges: false,
      apply,
      undo: () => ref.current && commit(undo(ref.current)),
      redo: () => ref.current && commit(redo(ref.current)),
      canUndo: (history?.past.length ?? 0) > 0,
      canRedo: (history?.future.length ?? 0) > 0,
      undoLabel: history ? undoLabel(history) : null,
      redoLabel: history ? redoLabel(history) : null,
      saveNow: async () => undefined,
      resolveConflict: () => undefined,
    }),
    [history, apply, commit, options.readOnly],
  );
}
