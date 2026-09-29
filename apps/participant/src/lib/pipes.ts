import type { AnswerStore } from "@myself/engine";
import type { PipeRef, ScoringDefinition } from "@myself/schema";
import { executeScoring, scoringItemKeys } from "@myself/scoring";

/**
 * Resolve piped placeholders in participant-facing text. Only structured pipe
 * references are supported (no arbitrary interpolation — docs/05 §2).
 */

/**
 * Scoring definitions frozen into the running release, so a `score` pipe can
 * tell a participant something about what they have just answered. Set once at
 * start-up from the manifest; without it, score pipes fall back rather than
 * inventing a number.
 */
let scoringByKey = new Map<string, ScoringDefinition>();
export function useScoringDefinitions(defs: Map<string, ScoringDefinition>): void {
  scoringByKey = defs;
}

/**
 * Run a scoring definition over the answers given so far and return one of its
 * outputs. Nothing is stored: this is a read of the current answers, computed
 * for display, exactly as the server will recompute it later from the same raw
 * data (D-33).
 */
function resolveScore(pipe: PipeRef, store: AnswerStore): string | null {
  if (!pipe.scoringKey || !pipe.output) return null;
  const def = scoringByKey.get(pipe.scoringKey);
  if (!def) return null;
  const values: Record<string, number | null> = {};
  for (const key of scoringItemKeys(def)) {
    const rec = store.get({ instrument: def.instrument, item: key, revision: 1 });
    values[key] = rec?.status === "answered" && rec.value?.kind === "choice" ? rec.value.code : null;
  }
  const out = executeScoring(def, values).outputs[pipe.output];
  if (out === null || out === undefined) return null;
  if (typeof out === "number") {
    return pipe.decimals === undefined ? String(out) : out.toFixed(pipe.decimals);
  }
  return out;
}

export function resolveText(
  text: string,
  pipes: Record<string, PipeRef> | undefined,
  store: AnswerStore,
  sessionStart: Date,
): string {
  if (!pipes) return text;
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
    const pipe = pipes[name];
    if (!pipe) return whole;
    // An unresolved pipe falls back to its declared text rather than leaving
    // the participant looking at "{first_name}".
    const unresolved = pipe.fallback ?? whole;
    switch (pipe.kind) {
      case "date_offset": {
        const d = new Date(sessionStart.getTime() + (pipe.offsetDays ?? 0) * 86_400_000);
        return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      }
      case "item_text_entry": {
        if (!pipe.item) return unresolved;
        const rec = store.get(pipe.item);
        if (rec?.status === "answered" && rec.value?.kind === "fields" && pipe.part !== undefined) {
          return rec.value.values[String(pipe.part)]?.trim() || unresolved;
        }
        if (rec?.status === "answered" && rec.value?.kind === "text") {
          return rec.value.value.trim() || unresolved;
        }
        return unresolved;
      }
      case "item_answer": {
        if (!pipe.item) return unresolved;
        const rec = store.get(pipe.item);
        if (rec?.status === "answered" && rec.value?.kind === "choice") return String(rec.value.code);
        if (rec?.status === "answered" && rec.value?.kind === "number") return String(rec.value.value);
        return unresolved;
      }
      case "score":
        return resolveScore(pipe, store) ?? unresolved;
      case "session_field":
        return unresolved; // populated when session metadata pipes are configured
    }
  });
}
