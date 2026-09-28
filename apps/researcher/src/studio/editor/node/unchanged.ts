import { canonicalJson } from "@myself/schema";
import type { StudioDraft } from "@myself/studio";

/**
 * An edit that changes nothing leaves the draft exactly as it was.
 *
 * REVIEW FIX: the model's operations always return a fresh copy of the draft,
 * even when the edit changes nothing — a space typed into an empty optional
 * box (stored as "no text"), a trailing space on an option label (stored
 * trimmed). Handed to `ctx.run`, a fresh copy is a change: it recorded an undo
 * step that undid nothing ("Undo edit help text" with no visible effect) and
 * marked the draft unsaved, so autosave wrote it again. Returning the draft it
 * was given tells the editor nothing happened (`apply` ignores an identical
 * draft), so neither follows.
 *
 * `part` picks what the edit can change (one question, one option list, one
 * screen); only that is compared, so it stays cheap on every keystroke.
 */
export function unlessUnchanged(before: StudioDraft, after: StudioDraft, part: (draft: StudioDraft) => unknown): StudioDraft {
  return canonicalJson(part(before) ?? null) === canonicalJson(part(after) ?? null) ? before : after;
}
