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
  /** The longitudinal key: the secret code (to r7.3.0) or the ID derived from name and date of birth (r8.0.0 on, D-52). Never a name. */
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
  /**
   * Who answered: the young person, or a parent or teacher about them.
   *
   * Taken from the form the release administered, not from anything the
   * respondent typed. A parent's answers about a child are filed under the
   * child's code with `informant: "parent"` — the same person, described from
   * a second point of view — which is how SDQ self and parent reports have
   * always been paired.
   */
  informant: z.string().optional(),
  releaseHash: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  /**
   * Durations, in milliseconds, and they measure different things on purpose.
   *
   * `durationMs` and `foregroundMs` are what the DEVICE measured, from a monotonic
   * clock, so neither is disturbed by an iPad's clock being wrong or changing mid-
   * sitting. Both cover the app session that FINISHED the sitting: the device's timer
   * starts fresh when a sitting is resumed after a reload or a crash, because a
   * monotonic clock does not survive the page being reloaded and nothing else it could
   * use would be trustworthy.
   *
   * `wallClockMs` is derived here instead, from the first and last event in the log, so
   * it always covers the WHOLE sitting — including any stretch where the app was closed.
   * For a sitting that was never interrupted the two agree closely; for one that was,
   * `wallClockMs` is longer and `resumedCount` says why.
   *
   * An analysis screening on time should say which it means. `resumedCount` is how you
   * find the sittings where it matters.
   */
  durationMs: z.number().int().min(0).optional(),
  foregroundMs: z.number().int().min(0).optional(),
  wallClockMs: z.number().int().min(0).optional(),
  /** How many times this sitting was resumed after the app stopped. */
  resumedCount: z.number().int().min(0),
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

/**
 * One identifying answer, held apart from everything else.
 *
 * These rows are the only place a name, a date of birth or a secret-code
 * component exists after ingest. They are returned from `ingest` in their own
 * partition so a caller has to decide, explicitly, to store them — and the
 * exports, the researcher view and the wide table are built from `responses`,
 * which cannot contain them.
 */
export const identityRow = z.object({
  participantId: z.string().min(1),
  sessionId: z.string().min(1),
  study: z.string().min(1),
  variable: z.string().min(1),
  value: z.string(),
  recordedAt: z.string().datetime(),
});

/**
 * A stated relationship between two participants.
 *
 * Parents and children, and twins with each other. Kept in the identity
 * partition rather than the dataset because knowing that two codes are a
 * parent and child is, in a school-sized sample, close to naming them.
 */
export const relationshipRow = z.object({
  study: z.string().min(1),
  /** The participant the relationship is stated from. */
  participantId: z.string().min(1),
  relatedId: z.string().min(1),
  kind: z.enum(["parent_of", "child_of", "sibling_of", "twin_of"]),
  recordedBy: z.string().min(1),
  recordedAt: z.string().datetime(),
  note: z.string().optional(),
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
export type IdentityRow = z.infer<typeof identityRow>;
export type RelationshipRow = z.infer<typeof relationshipRow>;
export type Dataset = z.infer<typeof dataset>;

export const emptyDataset = (): Dataset => ({
  generatedAt: new Date().toISOString(),
  releaseHashes: [],
  participants: [],
  sessions: [],
  responses: [],
  scores: [],
});

/**
 * The dataset restricted to some sittings. Wave numbers stay as derived from
 * the whole study — a filtered view may hold a child's wave 2 without their
 * wave 1, and that is the truth — while each participant's summary row is
 * recomputed from the sittings actually included.
 *
 * The researcher view uses it to leave out test sittings, and the research
 * dashboard (which vendors this file) to restrict an export or a summary to the
 * sittings a filter chose. One function, so "followed up" means the same in both.
 */
export function subsetDataset(d: Dataset, sessionIds: ReadonlySet<string>): Dataset {
  const sessions = d.sessions.filter((s) => sessionIds.has(s.sessionId));
  const byParticipant = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byParticipant.get(s.participantId);
    if (list) list.push(s);
    else byParticipant.set(s.participantId, [s]);
  }
  const participants: ParticipantRow[] = d.participants
    .filter((p) => byParticipant.has(p.participantId))
    .map((p) => {
      const mine = [...byParticipant.get(p.participantId)!].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return {
        ...p,
        sessionCount: mine.length,
        firstSeen: mine[0]!.startedAt,
        lastSeen: mine[mine.length - 1]!.startedAt,
        sites: [...new Set(mine.map((s) => s.site).filter((x): x is string => !!x))],
      };
    });
  return {
    generatedAt: d.generatedAt,
    releaseHashes: [...new Set(sessions.map((s) => s.releaseHash))],
    participants,
    sessions,
    responses: d.responses.filter((r) => sessionIds.has(r.sessionId)),
    scores: d.scores.filter((r) => sessionIds.has(r.sessionId)),
  };
}
