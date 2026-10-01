import {
  assessSitting,
  indexReleaseQuestions,
  replaySitting,
  type Assessment,
  type LoggedSitting,
  type ManifestForQuestions,
  type ReleaseQuestions,
  type ReplayResult,
  type RequiredLevel,
} from "./completeness.js";
import { subsetDataset, type Dataset } from "./dataset.js";
import { summarise, type DatasetSummary, type NumericSummary } from "./summary.js";

/**
 * How sittings are counted — one set of rules for the researcher view and the research
 * dashboard.
 *
 * The two tools read the same sittings from `studies/{study}/sessions`, and for a long
 * time counted them differently: the researcher view said 93.8% "completed" where the
 * dashboard said 85.7% "complete", because one meant "reached the end screen" and the
 * other "reached it with every required question answered", over different
 * denominators, after leaving out different sittings. Nothing on either screen said so.
 *
 * So the rules live here, and the dashboard vendors this file (scripts/vendor-survey.mjs
 * there): the same sitting is left out, judged and counted by the same lines in both. A
 * number both tools show under one label is the same number; where they differ, the
 * labels differ and say what is counted.
 *
 * THE RULES, in the order a sitting meets them:
 *
 *   1. Quarantined sittings (two copies that contradict each other) and unreadable ones
 *      (a spilled log missing a chunk) are LEFT OUT of every count, and the number left
 *      out is stated. `assemblePull` in the researcher view and `deriveStudyDataset` in
 *      the dashboard do the leaving out; both say how many.
 *   2. Test sittings — study code matching a test pattern, `^TST` and `^ZZZ` unless the
 *      study says otherwise — are left out unless somebody asks for them.
 *   3. Every other sitting is a SITTING, whether or not it can be filed under a
 *      participant. One with no name or date of birth still happened; it is counted and
 *      said to be "not linked to a participant", never dropped.
 *   4. Each sitting has one lifecycle (`lifecycleOf`): not started, in progress,
 *      abandoned, incomplete (reached the end, a required answer missing) or complete.
 *   5. Two completion measures, over one denominator — sittings that have finished or
 *      been abandoned, i.e. had their chance: "Reached the end" (complete + incomplete)
 *      and "All required answered" (complete). In progress and not started are in
 *      neither, because they have not had the chance to finish.
 *   6. Participants, follow-up, length, skips and speed come from the linked sittings
 *      only: they are facts about people and their answers, and an unlinked sitting has
 *      no person to be a fact about.
 */

export interface CountingRules {
  /** Study codes matching any of these (case-insensitive regular expressions) are test sittings. */
  testCodePatterns: readonly string[];
  /** Which `required` levels count for "all required answered". */
  requiredLevels: readonly RequiredLevel[];
  /** A sitting not heard from for this long is abandoned rather than in progress. */
  abandonAfterHours: number;
}

/**
 * The dashboard's defaults, which its administrators can change there (`config/policy`).
 * The researcher view cannot read that policy — it lives in the dashboard's own database
 * — so it counts with these and says which it used.
 */
export const DEFAULT_COUNTING_RULES: CountingRules = {
  testCodePatterns: ["^TST", "^ZZZ"],
  requiredLevels: ["hard", "soft"],
  abandonAfterHours: 24,
};

/** Is this a test sitting? A pattern that is not a valid expression matches nothing. */
export function isTestCode(studyCode: string | null | undefined, patterns: readonly string[]): boolean {
  if (!studyCode) return false;
  return patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(studyCode);
    } catch {
      return false;
    }
  });
}

export const LIFECYCLES = ["not_started", "in_progress", "abandoned", "incomplete", "complete"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export interface LifecycleFacts {
  /** Reached the end screen: the `complete` flag, or a `session.completed` event. */
  terminal: boolean;
  /** Any question answered, skipped or declined. */
  hasResponses: boolean;
  /** The sitting's own release is known, so its required answers can be judged. */
  releaseKnown: boolean;
  requiredMissing: number;
  /** When the study last received it (server clock), where known. */
  receivedAt?: string | null | undefined;
  /** The latest device timestamp in its log. */
  lastActivityAt?: string | null | undefined;
}

/**
 * Where a sitting stands.
 *
 * Derived when read, never stored, because "abandoned" depends on the time now. A sitting
 * whose release is unknown cannot be judged incomplete, so once it reaches the end it
 * counts as complete, and the dashboard shows its completeness as unavailable.
 */
export function lifecycleOf(facts: LifecycleFacts, abandonAfterHours: number, now: Date): Lifecycle {
  if (facts.terminal) return facts.releaseKnown && facts.requiredMissing > 0 ? "incomplete" : "complete";
  if (!facts.hasResponses) return "not_started";
  const heard = [facts.receivedAt, facts.lastActivityAt]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  // The server's clock first: a device clock can be hours out.
  const lastHeard =
    facts.receivedAt && Number.isFinite(Date.parse(facts.receivedAt)) ? Date.parse(facts.receivedAt) : Math.max(...heard, -Infinity);
  const windowMs = abandonAfterHours * 3_600_000;
  return Number.isFinite(lastHeard) && now.getTime() - lastHeard <= windowMs ? "in_progress" : "abandoned";
}

/** A sitting as the study holds it, as far as counting needs one. */
export interface SittingToCount extends LoggedSitting {
  sessionId: string;
  studyCode?: string | undefined;
  /** The release it was collected under, by content hash. */
  releaseHash?: string | undefined;
  startedAt?: string | undefined;
  /** When the study last received it (server clock). Absent for a sitting only ever seen in a file. */
  receivedAt?: string | undefined;
}

export interface JudgedSitting {
  lifecycle: Lifecycle;
  assessment: Assessment;
  replay: ReplayResult;
}

/** Judge one sitting from its own log, read through its own release (null when unknown). */
export function judgeSitting(
  sitting: SittingToCount,
  release: ReleaseQuestions | null,
  rules: Pick<CountingRules, "requiredLevels" | "abandonAfterHours">,
  now: Date,
): JudgedSitting {
  const replay = replaySitting(sitting);
  const assessment = assessSitting(replay, release, {
    requiredLevels: rules.requiredLevels,
    sittingStart: sitting.startedAt ?? replay.firstEventAt ?? null,
  });
  const lifecycle = lifecycleOf(
    {
      terminal: assessment.terminal,
      hasResponses: assessment.hasResponses,
      releaseKnown: assessment.releaseKnown,
      requiredMissing: assessment.counts.requiredMissing,
      receivedAt: sitting.receivedAt ?? null,
      lastActivityAt: replay.lastActivityAt ?? null,
    },
    rules.abandonAfterHours,
    now,
  );
  return { lifecycle, assessment, replay };
}

/** One counted sitting and where it stands. */
export interface SittingState {
  sessionId: string;
  lifecycle: Lifecycle;
}

/** The figures both tools show, over one set of counted sittings. */
export interface HeadlineFigures {
  /** Every sitting counted, whatever its state and whether or not it is linked. */
  sittings: number;
  /** Counted sittings filed under a participant. */
  linked: number;
  /** Counted sittings nobody could be filed under: no name or date of birth, or no complete code. */
  notLinked: number;
  participants: number;
  /** Participants with more than one counted sitting. */
  followedUp: number;
  maxWave: number;
  byLifecycle: Record<Lifecycle, number>;
  /** Complete + incomplete. */
  reachedEnd: number;
  /** Complete: reached the end with every applicable required question answered or declined. */
  allRequiredAnswered: number;
  /** Complete + incomplete + abandoned: the denominator of both completion rates. */
  finishedOrAbandoned: number;
  /** Device-timed minutes, over linked sittings that carry a time (those that reached the end). */
  durationMinutes: NumericSummary;
  /** Questions answered, and skipped or declined, over the linked sittings. */
  answered: number;
  skipped: number;
  /** Answers flagged as given faster than they could be read. */
  tooFast: number;
  /** skipped ÷ (answered + skipped). */
  skipRate: number;
  /** tooFast ÷ answered. */
  tooFastRate: number;
}

/** n ÷ d, or null when there is nothing to divide by. */
export const rateOf = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/**
 * The headline figures over the sittings counted.
 *
 * `data` is the dataset ingest built from every sitting the tool holds; `sittings` are the
 * ones counted, each with its lifecycle. The dataset is restricted here, not by the
 * caller, so the two tools cannot restrict it differently.
 */
export function headlineFigures(data: Dataset, sittings: readonly SittingState[]): HeadlineFigures & { dataset: Dataset; summary: DatasetSummary } {
  const ids = new Set(sittings.map((s) => s.sessionId));
  const linked = subsetDataset(data, ids);
  const summary = summarise(linked);
  const byLifecycle = Object.fromEntries(LIFECYCLES.map((l) => [l, 0])) as Record<Lifecycle, number>;
  for (const s of sittings) byLifecycle[s.lifecycle] += 1;
  const answered = linked.sessions.reduce((n, s) => n + s.answeredCount, 0);
  const skipped = linked.sessions.reduce((n, s) => n + s.skippedCount, 0);
  const tooFast = linked.sessions.reduce((n, s) => n + s.tooFastCount, 0);
  return {
    sittings: ids.size,
    linked: linked.sessions.length,
    notLinked: ids.size - linked.sessions.length,
    participants: summary.participants,
    followedUp: summary.returning,
    maxWave: summary.maxWave,
    byLifecycle,
    reachedEnd: byLifecycle.complete + byLifecycle.incomplete,
    allRequiredAnswered: byLifecycle.complete,
    finishedOrAbandoned: byLifecycle.complete + byLifecycle.incomplete + byLifecycle.abandoned,
    durationMinutes: summary.durationMinutes,
    answered,
    skipped,
    tooFast,
    skipRate: summary.skipRate,
    tooFastRate: summary.tooFastRate,
    dataset: linked,
    summary,
  };
}

export interface CountInput {
  /** Every sitting the tool holds and may count — quarantined and unreadable ones already left out. */
  sittings: readonly SittingToCount[];
  /** What ingest built from those sittings, test sittings included (they keep their place in the wave order). */
  dataset: Dataset;
  /** Release manifests by content hash; a sitting whose hash is not here has an unknown release. */
  manifests: ReadonlyMap<string, ManifestForQuestions>;
  rules?: CountingRules;
  /** Count test sittings too. Off by default, as in the dashboard. */
  includeTest?: boolean;
  now: Date;
}

export interface CountResult {
  figures: HeadlineFigures;
  /** The rules counted by, so a screen can say which. */
  rules: CountingRules;
  /** Test sittings among those held, and whether they were counted. */
  test: { count: number; included: boolean };
  /** Each counted sitting's lifecycle, by session id. */
  lifecycles: Map<string, Lifecycle>;
  /** The dataset restricted to the sittings counted: what the view shows and exports. */
  dataset: Dataset;
  summary: DatasetSummary;
}

/**
 * Count the sittings the researcher view holds, by the rules above.
 *
 * The dashboard reaches the same figures by a different road — each sitting is summarised
 * as it arrives and the lifecycle comes from that summary — and its tests feed one set of
 * sittings down both roads and require the answers to match.
 */
export function countSittings(input: CountInput): CountResult {
  const rules = input.rules ?? DEFAULT_COUNTING_RULES;
  const indexes = new Map<string, ReleaseQuestions | null>();
  const releaseFor = (hash: string): ReleaseQuestions | null => {
    if (!indexes.has(hash)) {
      const manifest = input.manifests.get(hash);
      let index: ReleaseQuestions | null = null;
      try {
        index = manifest ? indexReleaseQuestions(manifest) : null;
      } catch {
        // A release that cannot be read is an unknown release: no completeness, not a crash.
        index = null;
      }
      indexes.set(hash, index);
    }
    return indexes.get(hash)!;
  };

  const counted: SittingState[] = [];
  let test = 0;
  for (const sitting of input.sittings) {
    const isTest = isTestCode(sitting.studyCode, rules.testCodePatterns);
    if (isTest) test += 1;
    if (isTest && !input.includeTest) continue;
    const release = releaseFor(sitting.releaseHash ?? "");
    counted.push({ sessionId: sitting.sessionId, lifecycle: judgeSitting(sitting, release, rules, input.now).lifecycle });
  }

  const { dataset, summary, ...figures } = headlineFigures(input.dataset, counted);
  return {
    figures,
    rules,
    test: { count: test, included: input.includeTest === true },
    lifecycles: new Map(counted.map((s) => [s.sessionId, s.lifecycle])),
    dataset,
    summary,
  };
}
