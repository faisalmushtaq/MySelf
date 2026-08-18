import type { Dataset } from "./dataset.js";

/**
 * Narrative runs, in the dataset.
 *
 * The gap this closes: a study can run the micro-narrative module, store
 * twelve kilobytes per participant of interview, retellings, choice, rating
 * and correction — and none of it reached the archival export. The nightly
 * BIDS folder held the questionnaire and nothing else, so the half of the
 * method that produces the young person's own words in their own order was
 * present in Firestore and absent from the thing that is the dataset in thirty
 * years.
 *
 * Two files, for the same reason the rest of the export has two: the RAW LOG,
 * whole and unsummarised, because the conversation is the data; and a derived
 * table beside it, because a table is what somebody opens first. The table is
 * regenerable from the log and is never a substitute for it.
 *
 * The structural type is declared here rather than imported from
 * `@myself/narrative`. This package reads what a store holds, and a record
 * that arrived from an older build with a kind this one has never heard of
 * still has to be countable and still has to be exported. Being liberal about
 * the shape is what lets a reader be fixed years later without the data
 * having been narrowed on the way in.
 */

export interface StoredNarrativeRecord {
  seq: number;
  stageKey: string;
  source: "participant" | "model" | "system" | string;
  kind: string;
  text?: string | null;
  data?: Record<string, unknown> | null;
  at?: string;
}

export interface StoredNarrativeRun {
  sessionId: string;
  protocolKey: string;
  protocolVersion: string;
  /** Where the run came from. A tester link's run is never research data. */
  provenance?: "test" | "study";
  finished?: boolean;
  elapsedSeconds?: number;
  releaseHash?: string;
  records: StoredNarrativeRecord[];
}

/** The kinds that are a participant speaking, as opposed to being spoken to. */
const PARTICIPANT_WORDS = new Set([
  "participant_original",
  "participant_clarification",
  "participant_correction",
  "participant_edit",
]);

export interface NarrativeSummary {
  sessionId: string;
  protocolKey: string;
  protocolVersion: string;
  finished: boolean;
  elapsedSeconds: number | null;
  /** Messages the participant wrote, and how many words in total. */
  turns: number;
  words: number;
  /** Which retelling they chose, and out of how many they were offered. */
  chosenPersona: string | null;
  offered: number | null;
  rating: number | null;
  ratingMax: number | null;
  /** Whether they changed the retelling, by hand or by asking for a rewrite. */
  adapted: boolean;
  /** Whether they said it was already right — an answer, not an absence. */
  acceptedUnchanged: boolean;
  /** Set when a model stage failed and the protocol's fallback was applied. */
  fallbacks: number;
  finalScenario: string | null;
}

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Reduce one run to a row.
 *
 * Everything here is derived from the record log and nothing is taken on
 * trust from a summary field, so a run stored by an older build summarises
 * the same way as one stored today.
 */
export function summariseNarrative(run: StoredNarrativeRun): NarrativeSummary {
  const ordered = [...run.records].sort((a, b) => a.seq - b.seq);

  let turns = 0;
  let wordCount = 0;
  let chosenPersona: string | null = null;
  let offered: number | null = null;
  let rating: number | null = null;
  let ratingMax: number | null = null;
  let adapted = false;
  let acceptedUnchanged = false;
  let fallbacks = 0;
  let finalScenario: string | null = null;

  for (const record of ordered) {
    const data = record.data ?? {};
    if (PARTICIPANT_WORDS.has(record.kind) && record.text) {
      turns += 1;
      wordCount += words(record.text);
    }
    if (record.kind === "participant_edit") {
      adapted = true;
      if (record.text) finalScenario = record.text;
    }
    if (record.kind === "participant_correction") adapted = true;
    if (record.kind === "participant_reaction") {
      if (typeof data["persona"] === "string") {
        chosenPersona = data["persona"];
        if (typeof data["offered"] === "number") offered = data["offered"];
        if (typeof record.text === "string") finalScenario = record.text;
      }
      if (data["accepted"] === true) acceptedUnchanged = true;
      // A reverted adaptation puts an earlier version back, and that version
      // is the one they left with.
      if (typeof data["restored"] === "string") finalScenario = data["restored"];
    }
    if (record.kind === "participant_rating") {
      if (typeof data["rating"] === "number") rating = data["rating"];
      if (typeof data["max"] === "number") ratingMax = data["max"];
    }
    if (record.kind === "fallback_applied") fallbacks += 1;
  }

  return {
    sessionId: run.sessionId,
    protocolKey: run.protocolKey,
    protocolVersion: run.protocolVersion,
    finished: run.finished === true,
    elapsedSeconds: run.elapsedSeconds ?? null,
    turns,
    words: wordCount,
    chosenPersona,
    offered,
    rating,
    ratingMax,
    adapted,
    acceptedUnchanged,
    fallbacks,
    finalScenario,
  };
}

/**
 * The runs that belong in a research export.
 *
 * Two filters, both of which have to be passed rather than assumed.
 *
 * A run marked `test` came from a tester link — somebody piloting the module,
 * not a consented participant — and must never be counted as data. The mark is
 * put on by the relay from how the caller authenticated, so a page cannot
 * claim otherwise.
 *
 * A run whose session is not in the dataset has no participant to belong to.
 * That happens when the sitting is quarantined, withdrawn, or simply has not
 * been handed over yet, and in every one of those cases exporting the
 * conversation without the sitting it belongs to would be worse than leaving
 * it out: it would be a child's words with no code to withdraw them by.
 */
export function exportableNarratives(
  runs: StoredNarrativeRun[],
  data: Dataset,
): { run: StoredNarrativeRun; participantId: string; wave: number }[] {
  const sessions = new Map(data.sessions.map((s) => [s.sessionId, s]));
  const out: { run: StoredNarrativeRun; participantId: string; wave: number }[] = [];
  for (const run of runs) {
    if (run.provenance === "test") continue;
    const session = sessions.get(run.sessionId);
    if (!session) continue;
    out.push({ run, participantId: session.participantId, wave: session.wave });
  }
  return out;
}
