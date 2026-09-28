import type { StudioDraft } from "@myself/studio";

/**
 * Undo and redo for the draft.
 *
 * Whole-draft snapshots rather than inverse operations: every edit is a pure
 * function from one draft to the next, so keeping the drafts themselves is the
 * simplest thing that is obviously right. A snapshot is a reference to an
 * immutable object — the operations never mutate — so a hundred of them cost
 * little more than the parts that actually differ.
 *
 * Typing into one field produces an edit per keystroke. Consecutive edits with
 * the same label inside a short window are merged into one step, so undo
 * takes back "the wording change", not one letter.
 */

export interface Step {
  draft: StudioDraft;
  label: string;
  at: number;
}

export interface History {
  past: Step[];
  present: StudioDraft;
  presentLabel: string | null;
  presentAt: number;
  future: Step[];
}

export const HISTORY_LIMIT = 100;
export const MERGE_WINDOW_MS = 1200;

export function startHistory(draft: StudioDraft): History {
  return { past: [], present: draft, presentLabel: null, presentAt: 0, future: [] };
}

export function record(history: History, next: StudioDraft, label: string, now: number): History {
  if (next === history.present) return history;
  const merge = history.presentLabel === label && now - history.presentAt < MERGE_WINDOW_MS && history.past.length > 0;
  if (merge) {
    return { ...history, present: next, presentAt: now, future: [] };
  }
  const past = [...history.past, { draft: history.present, label, at: now }].slice(-HISTORY_LIMIT);
  return { past, present: next, presentLabel: label, presentAt: now, future: [] };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous.draft,
    presentLabel: null,
    presentAt: 0,
    future: [{ draft: history.present, label: previous.label, at: previous.at }, ...history.future],
  };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, { draft: history.present, label: next.label, at: next.at }],
    present: next.draft,
    presentLabel: null,
    presentAt: 0,
    future: history.future.slice(1),
  };
}

/** The label of what undo would take back, for the button's name. */
export function undoLabel(history: History): string | null {
  return history.past[history.past.length - 1]?.label ?? null;
}

export function redoLabel(history: History): string | null {
  return history.future[0]?.label ?? null;
}

/**
 * Adopt a draft from elsewhere (another editor's save, a server-side restore)
 * as the new starting point. History is cleared: undoing across somebody
 * else's save would silently revert their work.
 */
export function replace(draft: StudioDraft): History {
  return startHistory(draft);
}
