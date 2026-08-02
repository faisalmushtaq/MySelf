import { z } from "zod";
import { dottedKey, instrumentRef, semver, sha256, slug, ulid, variableName } from "./identifiers.js";
import { logicExpr } from "./logic.js";

/**
 * Draft assessment composition -> immutable release manifest.
 * Drafts are editable with an audit trail; publishing freezes everything and
 * produces a content hash. Nothing about a release is ever edited (docs/06 §3).
 */

export const sectionComponent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instrument"),
    ref: instrumentRef,
    displayIf: logicExpr.optional(),
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
      /** Seconds on one item before help is quietly offered. */
      dwellHintSeconds: z.number().int().min(5).default(30),
      /**
       * Below this many seconds on screen, an answer is faster than the item
       * could plausibly have been read. The response is still recorded — it is
       * the participant's answer and the raw data is never edited — but it is
       * flagged in the paradata so data quality can be judged afterwards.
       */
      tooFastSeconds: z.number().min(0).default(2),
      /**
       * Consecutive too-fast answers after which the participant is asked, once
       * and without accusation, whether they want to slow down. 0 disables.
       */
      tooFastRunPrompt: z.number().int().min(0).default(3),
    })
    .default({
      confirmSkip: true,
      skipRunCheckIn: 3,
      dwellHintSeconds: 30,
      tooFastSeconds: 2,
      tooFastRunPrompt: 3,
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
      body: z.string().min(1),
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
    "effort.pace_prompt_shown",
    "session.suspended",
    "session.resumed",
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
