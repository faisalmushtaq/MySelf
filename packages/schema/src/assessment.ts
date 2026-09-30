import { z } from "zod";
import { dottedKey, instrumentRef, semver, sha256, slug, ulid, variableName } from "./identifiers.js";
import { logicExpr } from "./logic.js";
import { displayText } from "./item.js";

/**
 * Draft assessment composition -> immutable release manifest.
 * Drafts are editable with an audit trail; publishing freezes everything and
 * produces a content hash. Nothing about a release is ever edited (docs/06 §3).
 */

/**
 * Which of the form's questions this placement shows, in the order it shows
 * them (D-49).
 *
 * ABSENT MEANS THE WHOLE FORM, in form order — which is what every release up to
 * r7.1.0 does, and why this is optional with no default: a stored manifest must
 * parse, and hash, exactly as it did when it was published.
 *
 * It exists so a question can move to another section without changing its ID.
 * A question's ID is `<instrument>.<key>`, so moving it into a different
 * instrument would make it a different question in every export. Instead the
 * same instrument is placed in both sections, each placement listing the
 * questions it carries. The publish gate refuses a key the form does not have,
 * and a question administered twice.
 */
const componentItems = z.array(slug).min(1).optional();

export const sectionComponent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instrument"),
    ref: instrumentRef,
    displayIf: logicExpr.optional(),
    items: componentItems,
    /** Per-component overrides constrained by the instrument's fidelity flags. */
    overrides: z
      .object({
        required: z.enum(["hard", "soft", "optional"]).optional(),
        allowDecline: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("module"),
    ref: instrumentRef, // modules share the instrument reference shape
    displayIf: logicExpr.optional(),
    items: componentItems,
  }),
  z.object({
    kind: z.literal("narrative"),
    protocol: dottedKey,
    protocolVersion: semver,
    displayIf: logicExpr.optional(),
  }),
  z.object({
    kind: z.literal("screen"), // consent / information / transition screens
    screen: slug,
    displayIf: logicExpr.optional(),
  }),
]);

export const section = z.object({
  key: slug,
  title: z.string().min(1),
  /** Participant-facing transition text (age-appropriate, researcher-set). */
  transition: z.string().optional(),
  displayIf: logicExpr.optional(),
  components: z.array(sectionComponent).min(1),
  randomiseComponents: z.boolean().default(false),
});

export const assessmentDraft = z.object({
  key: slug, // "ybm_nd2026_standard"
  study: slug,
  /** Full descriptive title. Researcher-facing: catalogues, exports, audit. */
  title: z.string().min(1),
  /**
   * Short label shown to participants on the opening screen — in practice the
   * site and the year ("Notre Dame · 2026"). Set per fielding by the
   * researcher; the full title is not what a participant needs to read before
   * starting. Omit to show nothing.
   */
  studyLabel: z.string().optional(),
  /** Ethics reference and contact address, shown quietly on the first screen. */
  contact: z
    .object({
      email: z.string().email(),
      ethicsReference: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  language: z.string().min(2),
  readingLevel: z.enum(["standard", "simplified", "early_reader"]),
  ageBand: z.enum(["8-10", "11-13", "14-16", "17-18", "adult"]),
  allowBackNavigation: z.boolean().default(true),
  resumption: z.enum(["resume_same_device", "restart", "disabled"]).default("resume_same_device"),
  progressIndicator: z.enum(["sections", "none"]).default("sections"),
  /**
   * The code entered on the opening screen, before anything else. This is the
   * code the research team issues — not anything the participant invents — so
   * it carries its own instructions as well as its format.
   */
  participantCode: z
    .object({
      pattern: z.string(),
      hint: z.string(),
      /** Field label, e.g. "Your study code". */
      label: z.string().default("Your participant code"),
      /** Where the code comes from and what to do without one. */
      instructions: z.string().optional(),
      placeholder: z.string().optional(),
      /**
       * Variable the code is stored against, so it never has to be asked for a
       * second time inside the survey.
       */
      variable: variableName.optional(),
    })
    .optional(),
  /**
   * Response-effort safeguards. Skipping stays possible — these add
   * deliberation, not obstruction (docs/11 §3).
   */
  effort: z
    .object({
      /** Ask for confirmation before an unanswered item is skipped. */
      confirmSkip: z.boolean().default(true),
      /** Consecutive skips after which a check-in screen is shown. */
      skipRunCheckIn: z.number().int().min(2).default(3),
      /**
       * Floor, in seconds, before help is quietly offered on an item. The
       * actual wait scales with how much the screen asks people to read and
       * weigh, so a two-word question does not sit there for the same time as
       * a page of consent statements.
       */
      dwellHintSeconds: z.number().int().min(5).default(20),
      /**
       * Reading speed used to scale the dwell wait. Set near real silent
       * reading speed for this age group (~3 words a second), then multiplied
       * by the allowance below — someone is only "stuck" once they have had
       * time to read the thing several times over.
       */
      dwellWordsPerSecond: z.number().positive().default(3),
      /** How many times over the reading time counts as stuck rather than thinking. */
      dwellReadingMultiple: z.number().positive().default(3),
      /** Upper bound, so a long screen never waits absurdly long to offer help. */
      dwellMaxSeconds: z.number().int().positive().default(90),
      /**
       * Floor for the too-fast threshold, in seconds. Applies to the shortest
       * items, where there is barely anything to read: a one-word question
       * genuinely can be answered in a moment, and flagging that is noise.
       */
      tooFastSeconds: z.number().min(0).default(0.8),
      /**
       * Reading speed used to scale the threshold to how much the item
       * actually says. Deliberately far above real reading speed (~3-4 words
       * a second for this age group): the flag is for speeds that are not
       * reading at all, not for people who read briskly. A fifty-word consent
       * statement answered in under six seconds was not read; a four-word
       * battery item answered in one second may well have been.
       */
      tooFastWordsPerSecond: z.number().positive().default(8),
      /** Upper bound, so a very long screen cannot demand an absurd minimum. */
      tooFastMaxSeconds: z.number().positive().default(6),
      /**
       * Consecutive too-fast answers after which the participant is asked, once
       * and without accusation, whether they want to slow down. 0 disables.
       */
      tooFastRunPrompt: z.number().int().min(0).default(5),
    })
    .default({
      confirmSkip: true,
      skipRunCheckIn: 3,
      dwellHintSeconds: 20,
      dwellWordsPerSecond: 3,
      dwellReadingMultiple: 3,
      dwellMaxSeconds: 90,
      tooFastSeconds: 0.8,
      tooFastWordsPerSecond: 8,
      tooFastMaxSeconds: 6,
      tooFastRunPrompt: 5,
    }),
  offline: z.object({
    surveyOfflineCapable: z.literal(true), // conventional content MUST work offline
    narrativeConnectivity: z.enum(["online_required", "offline_capable_with_queue"]).optional(),
  }),
  sections: z.array(section).min(1),
  screens: z.record(
    slug,
    z.object({
      kind: z.enum(["consent", "assent", "information", "transition", "finish"]),
      /** Heading, where the screen has one distinct from its body. */
      title: displayText.optional(),
      /**
       * Piped like any other participant-facing text, so a name given at the
       * start can be used at the end without being asked for again.
       */
      body: displayText,
    }),
  ),
  notes: z.string().optional(),
});

/** Frozen, hashed release manifest. Content-complete: everything a participant
 * can experience is either embedded or content-addressed here. */
export const releaseManifest = z.object({
  manifestVersion: z.literal(1),
  release: z.object({
    key: slug,
    version: semver,
    assessment: slug,
    study: slug,
    publishedAt: z.string().datetime(),
    publishedBy: z.string().min(1),
    engineVersion: z.string().min(1),
    decisionRefs: z.array(z.string()).optional(), // e.g. ["D-01", "D-05"]
  }),
  composition: assessmentDraft,
  /** Embedded frozen definitions, keyed by reference string. */
  instruments: z.record(z.string(), z.unknown()),
  scales: z.record(z.string(), z.unknown()),
  scoring: z.record(z.string(), z.unknown()),
  narrativeProtocols: z.record(z.string(), z.unknown()),
  prompts: z.record(z.string(), z.unknown()),
  modelConfigs: z.record(z.string(), z.unknown()),
  assets: z.record(slug, z.object({ path: z.string(), sha256, bytes: z.number().int() })),
  hash: sha256.optional(), // computed over the JCS form with `hash` absent
});

export const sessionState = z.enum([
  "not_started",
  "in_progress",
  "completed_locally",
  "awaiting_sync",
  "syncing",
  "synced_verified",
  "sync_failed",
  "quarantined",
]);

/** Exclusive response-status taxonomy (docs/06 §4). */
export const responseStatus = z.enum([
  "answered",
  "skipped",
  "declined",
  "not_presented_branching",
  "not_reached_ended",
  "invalid",
  "lost_technical",
  "pending_sync",
]);

export const responseEvent = z.object({
  eventId: ulid,
  sessionId: ulid,
  seq: z.number().int().min(0),
  type: z.enum([
    "item.presented",
    "response.recorded",
    "response.changed",
    "item.skipped",
    "item.declined",
    "navigation.back",
    "section.completed",
    "session.started",
    "session.completed",
    "narrative.stage",
    "hint.shown",
    "skip.confirmed",
    "skip.abandoned",
    "effort.checkin_shown",
    "effort.checkin_returned",
    // Timing paradata (D-23). item.left closes every viewing of an item and
    // carries the dwell for that viewing, so total time on an item, number of
    // viewings and time-to-first-response are all reconstructable from the log
    // without any of it being derived at capture time.
    "item.left",
    "response.too_fast",
    /** Answer contradicted an earlier one; recorded, flagged, and reconciled
     *  on screen rather than left for the analyst to find (D-25). */
    "response.inconsistent",
    "effort.pace_prompt_shown",
    "session.suspended",
    "session.resumed",
    /** Last look over the answers before finishing, and any edit made from
     *  it — so a corrected answer is distinguishable from a first one (D-30). */
    "review.opened",
    "review.edited",
  ]),
  itemRef: z
    .object({ instrument: slug, item: slug, revision: z.number().int().positive() })
    .optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  tWall: z.string().datetime(),
  tMono: z.number(), // monotonic ms since session start
});

/**
 * Per-item timing summary, derived from the event log rather than captured
 * separately — the log stays the single source of truth (docs/06 §4).
 */
export const itemTiming = z.object({
  itemKey: z.string().min(1),
  /** Every separate viewing of the item, in order. */
  visits: z.number().int().min(1),
  /** Summed milliseconds the item was on screen across all visits. */
  dwellMs: z.number().int().min(0),
  /** Milliseconds from first presentation to the first recorded response. */
  timeToFirstResponseMs: z.number().int().min(0).optional(),
  /** Times the answer was changed after first being given. */
  changes: z.number().int().min(0),
  /** Answered faster than the item could plausibly have been read. */
  tooFast: z.boolean(),
});

export type ItemTiming = z.infer<typeof itemTiming>;

export type AssessmentDraft = z.infer<typeof assessmentDraft>;
export type ReleaseManifest = z.infer<typeof releaseManifest>;
export type ResponseEvent = z.infer<typeof responseEvent>;
export type SessionState = z.infer<typeof sessionState>;
export type ResponseStatus = z.infer<typeof responseStatus>;
