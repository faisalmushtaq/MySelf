import { useRef } from "react";

/**
 * A question's identity in the editor, kept across a change of ID.
 *
 * Renaming a question changes its ID (`<instrument>.<key>`), and the selection
 * follows it. The panels are keyed by question so that moving to another
 * question starts them afresh — but a rename is the same question, and
 * remounting the settings panel on every keystroke of a new ID would throw
 * away the caret in the very box being typed in. So a rename made here is
 * noted, and a panel that sees its question become the renamed one keeps its key.
 */

const renamed = new Map<string, string>();

/** Record that the editor renamed `from` to `to`. */
export function noteRename(from: string, to: string): void {
  if (from !== to) renamed.set(from, to);
}

/** Where a selection that no longer exists has probably gone: a rename, or its undo. */
export function renameCandidates(itemKey: string): string[] {
  const out: string[] = [];
  const forward = renamed.get(itemKey);
  if (forward) out.push(forward);
  for (const [from, to] of renamed) if (to === itemKey) out.push(from);
  return out;
}

/** A key for React that survives the editor's own renames of this question. */
export function useQuestionIdentity(itemKey: string): string {
  const ref = useRef<{ itemKey: string; key: string } | null>(null);
  if (!ref.current) ref.current = { itemKey, key: itemKey };
  else if (ref.current.itemKey !== itemKey) {
    const followed = renamed.get(ref.current.itemKey) === itemKey;
    ref.current = { itemKey, key: followed ? ref.current.key : itemKey };
  }
  return ref.current.key;
}
