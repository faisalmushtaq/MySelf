import type { AnswerStore } from "@myself/engine";
import type { PipeRef } from "@myself/schema";

/**
 * Resolve piped placeholders in participant-facing text. Only structured pipe
 * references are supported (no arbitrary interpolation — docs/05 §2).
 */

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
      case "session_field":
        return unresolved; // populated when session metadata pipes are configured
    }
  });
}
