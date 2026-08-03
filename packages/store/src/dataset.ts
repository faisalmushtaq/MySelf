import { z } from "zod";

/**
 * The canonical dataset: one shape that the database, the BIDS export and the
 * researcher view all read.
 *
 * Three principles carried from the design (docs/06 §4), each of which the
 * types here enforce rather than merely document:
 *
 *   1. RAW IS RAW. `responses` holds exactly what the participant did,
 *      including skips and declines as first-class statuses. Nothing derived
 *      is ever written back into it.
 *   2. DERIVED IS SEPARATE AND REGENERABLE. `scores` is computed from
 *      responses and can be thrown away and rebuilt. It records which scoring
 *      definition produced it, so a rescoring years later is auditable.
 *   3. IDENTIFIERS LIVE APART. Names and dates of birth are not in this shape
 *      at all — they belong to the identity schema, which is stored and
 *      access-controlled separately. What links a person across waves is the
 *      derived participant code, which is not reversible to a name.
 */

export const responseStatus = z.enum([
  "answered",
  "skipped",
  "declined",
  "not_presented_branching",
  "not_reached_ended",
  "invalid",
  "lost_technical",
]);

/** One participant, as they appear across every wave they have taken part in. */
export const participantRow = z.object({
  /** Derived secret code — the longitudinal key. Never a name. */
  participantId: z.string().min(1),
  /** Study this participant belongs to. */
  study: z.string().min(1),
  /** First and most recent session dates, for cohort description. */
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  sessionCount: z.number().int().min(1),
  /** Site/school labels the participant has been seen at, in order. */
  sites: z.array(z.string()),
});

/** One sitting. A participant has one row here per wave they complete. */
export const sessionRow = z.object({
  sessionId: z.string().min(1),
  participantId: z.string().min(1),
  study: z.string().min(1),
  /** Ordinal wave for this participant: 1 for their first session, 2 next. */
  wave: z.number().int().min(1),
  /** Researcher-issued code for the sitting (site + cohort). */
  studyCode: z.string().optional(),
  /** Site derived from the study code's letters, where it has them. */
  site: z.string().optional(),
  releaseKey: z.string().min(1),
  /** Content hash of the release, so answers are always interpretable. */
  releaseHash: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  /** Wall-clock and foreground durations, in milliseconds. */
  durationMs: z.number().int().min(0).optional(),
  foregroundMs: z.number().int().min(0).optional(),
  /** Counts that describe how the sitting went, for data-quality screening. */
  answeredCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  tooFastCount: z.number().int().min(0),
  revisitedCount: z.number().int().min(0),
  reviewEdits: z.number().int().min(0),
  complete: z.boolean(),
});

/** One answer. Long format: a row per variable per session. */
export const responseRow = z.object({
  sessionId: z.string().min(1),
  participantId: z.string().min(1),
  instrument: z.string().min(1),
  item: z.string().min(1),
  /** Canonical analysis variable name. */
  variable: z.string().min(1),
  status: responseStatus,
  /** Canonical code for a choice, the number for a numeric, else null. */
  value: z.number().nullable(),
  /** Free text, or a rendered form of a structured answer. */
  text: z.string().nullable(),
  /** The option label as the participant saw it, for readable exports. */
  label: z.string().nullable(),
  /** Milliseconds on screen, summed across every visit to the item. */
  dwellMs: z.number().int().min(0).nullable(),
  /** How many times the participant came back to it. */
  visits: z.number().int().min(1).nullable(),
  /** Answered faster than the item could plausibly have been read. */
  tooFast: z.boolean(),
  /** Answer was changed after first being given. */
  changed: z.boolean(),
});

/** One derived value. Regenerable; never mixed into `responses`. */
export const scoreRow = z.object({
  sessionId: z.string().min(1),
  participantId: z.string().min(1),
  instrument: z.string().min(1),
  scoringKey: z.string().min(1),
  scoringVersion: z.string().min(1),
  output: z.string().min(1),
  value: z.union([z.number(), z.string()]).nullable(),
  /** Non-missing items that contributed, for judging a partial scale. */
  validCount: z.number().int().min(0).nullable(),
  /** Anything the scorer wanted the analyst to know. */
  warnings: z.array(z.string()),
});

export const dataset = z.object({
  /** Provenance for the whole dataset, carried into every export. */
  generatedAt: z.string().datetime(),
  /** Release hashes present in this dataset — more than one after a rerelease. */
  releaseHashes: z.array(z.string()),
  participants: z.array(participantRow),
  sessions: z.array(sessionRow),
  responses: z.array(responseRow),
  scores: z.array(scoreRow),
});

export type ResponseStatusValue = z.infer<typeof responseStatus>;
export type ParticipantRow = z.infer<typeof participantRow>;
export type SessionRow = z.infer<typeof sessionRow>;
export type ResponseRow = z.infer<typeof responseRow>;
export type ScoreRow = z.infer<typeof scoreRow>;
export type Dataset = z.infer<typeof dataset>;

export const emptyDataset = (): Dataset => ({
  generatedAt: new Date().toISOString(),
  releaseHashes: [],
  participants: [],
  sessions: [],
  responses: [],
  scores: [],
});
