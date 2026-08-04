import { z } from "zod";

/**
 * Staged records — never a single conversation blob.
 *
 * The audited implementation stored a chat log and a scenario side by side.
 * That loses the distinctions the science depends on: which words are the
 * participant's, which are the model's, what the participant was shown, and
 * what they said about it afterwards. Each of those is its own append-only
 * record here, with a source that cannot be forged by ordering.
 *
 * Three invariants the storage layer enforces:
 *
 *   1. `participant_original` is immutable and is never superseded by model
 *      output. A correction is a new record linked to what it corrects.
 *   2. Reprocessing appends. Re-running a model stage years later with a
 *      better model produces new records beside the old ones, so the original
 *      analysis remains reproducible.
 *   3. Every record carries its order and its time, so a conversation can be
 *      replayed exactly as it happened.
 */

export const recordSource = z.enum(["researcher", "participant", "system", "model", "reviewer", "analysis"]);

export const recordKind = z.enum([
  "request_shown",
  "participant_original",
  "validation_result",
  "clarification_request",
  "participant_clarification",
  "prompt_resolved",
  "model_raw",
  "model_validated",
  "model_shown",
  "participant_reaction",
  "participant_rating",
  "participant_correction",
  "safeguarding_flag",
  "stage_skipped",
  "fallback_applied",
  "derived_measure",
]);

export const narrativeRecord = z.object({
  recordId: z.string().min(1),
  sessionId: z.string().min(1),
  protocolKey: z.string().min(1),
  protocolVersion: z.string().min(1),
  stageKey: z.string().min(1),
  seq: z.number().int().min(0),
  source: recordSource,
  kind: recordKind,
  /** The content of the record. Text for participant and model turns. */
  text: z.string().nullable(),
  /** Structured payload — validated model output, ratings, flags. */
  data: z.record(z.unknown()).nullable(),
  /** The record this one is about: a correction points at what it corrects. */
  refersTo: z.string().nullable(),
  /** Provenance row for model records. */
  modelCallId: z.string().nullable(),
  at: z.string().datetime(),
});

export type NarrativeRecord = z.infer<typeof narrativeRecord>;
export type RecordKind = z.infer<typeof recordKind>;
export type RecordSource = z.infer<typeof recordSource>;

/** Sources that may never write a participant's words. */
const NOT_THE_PARTICIPANT: ReadonlySet<RecordSource> = new Set(["model", "system", "researcher", "analysis"]);

/**
 * Check a proposed record against the invariants before it is appended.
 *
 * Returns the reason it must be refused, or null. This is the structural
 * guarantee behind "the model cannot fabricate a participant response": there
 * is no path by which a model record becomes a participant one.
 */
export function refuseReason(
  proposed: Pick<NarrativeRecord, "kind" | "source" | "refersTo">,
  existing: NarrativeRecord[],
): string | null {
  if (proposed.kind === "participant_original") {
    if (NOT_THE_PARTICIPANT.has(proposed.source)) {
      return `a ${proposed.source} record cannot be a participant_original — model output may never become a participant's words`;
    }
  }

  if (proposed.source === "model" && proposed.kind !== "model_raw" && proposed.kind !== "model_validated") {
    if (proposed.kind !== "safeguarding_flag") {
      return `a model record may only be model_raw, model_validated or safeguarding_flag, not ${proposed.kind}`;
    }
  }

  if (proposed.kind === "participant_correction" && !proposed.refersTo) {
    return "a correction must say what it corrects";
  }

  if (proposed.refersTo && !existing.some((r) => r.recordId === proposed.refersTo)) {
    return `refersTo points at ${proposed.refersTo}, which is not a record in this session`;
  }

  return null;
}

/** The participant's own words, in order — what the analysis is actually of. */
export function participantWords(records: NarrativeRecord[]): NarrativeRecord[] {
  return records
    .filter((r) => r.source === "participant" && (r.kind === "participant_original" || r.kind === "participant_clarification"))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Whether a participant's original words survived the run intact.
 *
 * The failure this guards against is the audited app's: a generation failure
 * writing an apology string into the slot where a scenario should be, so the
 * loss is only visible to somebody reading the text. Here a failure is a
 * `fallback_applied` record and the original is untouched, and this reports
 * exactly that.
 */
export function originalsIntact(records: NarrativeRecord[]): boolean {
  const originals = records.filter((r) => r.kind === "participant_original");
  return originals.every((original) => {
    const superseded = records.some(
      (r) => r.refersTo === original.recordId && r.source === "model" && r.kind !== "safeguarding_flag",
    );
    return !superseded && typeof original.text === "string" && original.text.length > 0;
  });
}
