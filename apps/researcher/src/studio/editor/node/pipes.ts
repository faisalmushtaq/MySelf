import type { PipeRef } from "@myself/schema";
import { findQuestion, shortText, type StudioDraft } from "@myself/studio";

/**
 * Inserted answers ("pipes") in participant-facing text, described for the
 * researcher: `{first_name}` in the finish screen's title is "the answer to
 * ‘First Name’, or ‘and well done’ if it wasn't given".
 *
 * The text is edited as it stands, placeholders and all; the Studio does not
 * yet create new insertions, so typing a new {name} is reported by validation
 * as unresolved rather than silently accepted.
 */

export interface PipeUse {
  name: string;
  /** Present in the text as {name}. */
  used: boolean;
  /** Set up to be filled in. */
  defined: boolean;
  /** What it inserts, in words; null for an unresolved placeholder. */
  description: string | null;
  fallback: string | null;
}

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

function describe(pipe: PipeRef, draft: StudioDraft): string {
  switch (pipe.kind) {
    case "item_answer":
    case "item_text_entry": {
      const key = pipe.item ? `${pipe.item.instrument}.${pipe.item.item}` : null;
      const q = key ? findQuestion(draft, key) : null;
      const which = q ? `“${shortText(q.item.stem.text, 50)}”` : key ? `${key} (no longer in the survey)` : "a question";
      const part = pipe.part !== undefined && q?.item.responseType === "form_fields" ? q.item.fields.find((f) => f.key === pipe.part)?.label : pipe.part;
      return `the answer to ${which}${part !== undefined ? ` (${String(part)})` : ""}`;
    }
    case "score":
      return `a score (${pipe.scoringKey ?? "?"}${pipe.output ? `, ${pipe.output}` : ""}) worked out from the answers`;
    case "session_field":
      return pipe.field === "participant_code"
        ? "the participant code"
        : pipe.field === "study_name"
          ? "the study's name"
          : "the date the sitting started";
    case "date_offset":
      return `the date ${pipe.offsetDays ?? 0} days after the sitting started`;
  }
}

/** Every placeholder in a piece of text and every insertion set up for it. */
export function pipeUses(display: { text: string; pipes?: Record<string, PipeRef> | undefined } | undefined, draft: StudioDraft): PipeUse[] {
  if (!display) return [];
  const used = new Set<string>();
  for (const match of display.text.matchAll(PLACEHOLDER)) used.add(match[1]!);
  const pipes = display.pipes ?? {};
  const names = [...new Set([...used, ...Object.keys(pipes)])];
  return names.map((name) => {
    const pipe = Object.prototype.hasOwnProperty.call(pipes, name) ? pipes[name] : undefined;
    return {
      name,
      used: used.has(name),
      defined: pipe !== undefined,
      description: pipe ? describe(pipe, draft) : null,
      fallback: pipe?.fallback ?? null,
    };
  });
}
